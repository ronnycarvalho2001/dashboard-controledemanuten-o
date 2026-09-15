import { getSupabase, lazyCleanup } from "./_lib/supabase.js";
import { plantId, ingeconHeaders, todayInPlantTz, toISODate, canonicalBoardId } from "./_lib/ingecon.js";

// Soma só os incrementos positivos entre amostras consecutivas do dia (ignora quedas, que
// são resets do contador). Em dia normal, sem resets, isso equivale a (última - primeira)
// amostra. Também cobre o caso raro de reset NO MEIO do dia (contador volta a ~0 e reacumula
// antes de fechar o dia) — nesse caso (última - primeira) daria negativo/errado.
function sumPositiveDeltas(samples, field) {
  let sum = 0;
  for (let i = 1; i < samples.length; i++) {
    const d = (samples[i][field] ?? 0) - (samples[i - 1][field] ?? 0);
    if (d > 0) sum += d;
  }
  return sum;
}

// Recomputa e_injection/e_absorption a partir das amostras cruas do dia (mesmo endpoint que
// availability.js já consulta), em vez de confiar no valor pré-agregado do /groupbyday. O
// /groupbyday assume que o contador acumulado do inversor zera à meia-noite e devolve a
// última leitura do dia como se fosse o total diário; quando isso falha (falha transitória de
// comunicação), o contador carrega o total do dia anterior — ou até reseta de novo no meio do
// dia — inflando (ou distorcendo) o valor reportado.
// `datesToCorrect` limita o trabalho extra (1 chamada upstream por data) só às datas que
// realmente precisam — hoje (que muda a cada sync) e datas ainda sem cache. Sem esse limite,
// toda sincronização recorrigiria as ~30 datas do intervalo padrão do front, arriscando estourar
// o timeout da function a cada auto-sync. Dias antigos já cacheados/corrigidos não são
// retocados aqui — correção retroativa é um backfill à parte, não o caminho quente.
async function correctResetFailures(rows, headers, datesToCorrect) {
  const dates = [...new Set(rows.map(r => r.date))].filter(d => datesToCorrect.has(d));
  for (const date of dates) {
    const ymd = date.replace(/-/g, "");
    const url = `https://www.ingeconsunmonitor.com/api/ingecon/samplesv2/plant/${plantId()}/date/${ymd}`;
    let sampleRes;
    try {
      sampleRes = await fetch(url, { headers });
      if (sampleRes.status === 429) { // rate limit transitório — espera e tenta uma vez mais
        await new Promise(r => setTimeout(r, 4000));
        sampleRes = await fetch(url, { headers });
      }
    } catch {
      continue; // falha ao buscar amostras do dia — mantém o valor bruto do groupbyday
    }
    if (!sampleRes.ok) continue;
    const samples = await sampleRes.json();

    const byBoard = new Map();
    samples.forEach(s => {
      if (!s.BoardId || !s.DateTime) return;
      const boardId = canonicalBoardId(s.BoardId);
      if (!byBoard.has(boardId)) byBoard.set(boardId, []);
      byBoard.get(boardId).push(s);
    });
    byBoard.forEach(arr => arr.sort((a, b) => a.DateTime.localeCompare(b.DateTime)));

    rows.forEach(row => {
      if (row.date !== date) return;
      const samplesForBoard = byBoard.get(row.sn);
      if (!samplesForBoard || samplesForBoard.length < 2) return; // sem amostras suficientes — mantém valor bruto
      row.e_injection = sumPositiveDeltas(samplesForBoard, "EInjection");
      row.e_absorption = sumPositiveDeltas(samplesForBoard, "EAbsorption");
    });
  }
}

function eachIsoDate(fromIso, toIso) {
  const out = [];
  const d = new Date(fromIso + "T00:00:00Z");
  const end = new Date(toIso + "T00:00:00Z");
  while (d <= end) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

// Proxy + cache (Supabase) para geração diária por inversor.
// Usa /ingecon/samplesv2/groupbyday, que cobre um intervalo inteiro de dias numa única chamada.
export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { from, to } = req.query;
  if (!from || !/^\d{8}$/.test(from) || !to || !/^\d{8}$/.test(to)) {
    return res.status(400).json({ error: "Parâmetros 'from' e 'to' inválidos — use o formato YYYYMMDD" });
  }

  let supabase;
  try {
    supabase = getSupabase();
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  const fromIso = toISODate(from);
  const toIso = toISODate(to);
  const today = todayInPlantTz();
  const includesToday = from <= today && today <= to;

  const { data: cached, error: readErr } = await supabase
    .from("ingecon_generation_daily")
    .select("sn,date,e_injection,e_absorption")
    .gte("date", fromIso)
    .lte("date", toIso);
  if (readErr) return res.status(500).json({ error: "Erro ao ler cache: " + readErr.message });

  const cachedDates = new Set((cached || []).map(r => r.date));
  const allDates = eachIsoDate(fromIso, toIso);
  const hasGap = allDates.some(d => !cachedDates.has(d));
  const needsFetch = hasGap || includesToday;

  let merged = cached || [];

  if (needsFetch) {
    let headers;
    try {
      headers = ingeconHeaders();
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
    const url = `https://www.ingeconsunmonitor.com/api/ingecon/samplesv2/groupbyday/plant/${plantId()}/from/${from}/to/${to}`;
    let upstreamRes;
    try {
      upstreamRes = await fetch(url, { headers });
    } catch {
      return res.status(502).json({ error: "Falha ao contatar a API do INGECON SUN Monitor" });
    }
    if (!upstreamRes.ok) {
      const text = await upstreamRes.text().catch(() => "");
      return res.status(upstreamRes.status).json({
        error: `INGECON API retornou ${upstreamRes.status}`,
        detail: text.slice(0, 500),
      });
    }
    const records = await upstreamRes.json();

    // Agrupa por BoardId, não por SN: pelo menos um SN (H10022560016) é reaproveitado por
    // dois boards físicos diferentes — BoardId é o identificador realmente único por inversor.
    // A coluna "sn" da tabela guarda o BoardId.
    const bySnDate = new Map();
    records.filter(r => r.BoardId && r.DateTime).forEach(r => {
      const boardId = canonicalBoardId(r.BoardId);
      const key = `${boardId}|${String(r.DateTime).slice(0, 10)}`;
      const prev = bySnDate.get(key);
      if (prev) {
        prev.e_injection = (prev.e_injection ?? 0) + (r.EInjection ?? 0);
        prev.e_absorption = (prev.e_absorption ?? 0) + (r.EAbsorption ?? 0);
      } else {
        bySnDate.set(key, {
          sn: boardId,
          date: String(r.DateTime).slice(0, 10),
          e_injection: r.EInjection ?? null,
          e_absorption: r.EAbsorption ?? null,
          updated_at: new Date().toISOString(),
        });
      }
    });
    const rows = [...bySnDate.values()];

    const datesToCorrect = new Set(allDates.filter(d => !cachedDates.has(d)));
    if (includesToday) datesToCorrect.add(toISODate(today));
    await correctResetFailures(rows, headers, datesToCorrect);

    // Só regrava as datas que passaram pela correção acima. Datas já cacheadas fora desse
    // conjunto ficam como estão: regravar a resposta bruta do /groupbyday pra elas sobrescreveria
    // um valor já corrigido (por essa mesma rota, num sync anterior) de volta pro valor errado.
    const rowsToPersist = rows.filter(r => datesToCorrect.has(r.date));

    if (rowsToPersist.length) {
      const { error: upsertErr } = await supabase
        .from("ingecon_generation_daily")
        .upsert(rowsToPersist, { onConflict: "sn,date" });
      if (upsertErr) return res.status(500).json({ error: "Erro ao gravar cache: " + upsertErr.message });
    }

    const byKey = new Map();
    (cached || []).forEach(r => byKey.set(`${r.sn}|${r.date}`, r));
    rowsToPersist.forEach(r => byKey.set(`${r.sn}|${r.date}`, r));
    merged = [...byKey.values()];
  }

  await lazyCleanup(supabase).catch(() => {});

  res.setHeader("Cache-Control", includesToday
    ? "public, s-maxage=60, stale-while-revalidate=300"
    : "public, s-maxage=3600, stale-while-revalidate=86400");

  return res.status(200).json(
    merged.map(r => ({ sn: r.sn, date: r.date, eInjection: r.e_injection, eAbsorption: r.e_absorption }))
  );
}

import { getSupabase, lazyCleanup } from "./_lib/supabase.js";
import { plantId, ingeconHeaders, todayInPlantTz, toISODate, canonicalBoardId } from "./_lib/ingecon.js";

// Um dia fechado só é considerado "definitivo" no cache se os dados cobrem (quase) o dia
// inteiro. Caso contrário, o cache foi gravado no meio do dia (alguém abriu o dash antes das
// 17:30) e nunca mais foi atualizado — inversor que caiu horas depois da última visita fica
// escondido pra sempre, mostrando o último valor positivo salvo em vez da queda real.
const COMPLETE_THRESHOLD_MINS = 17 * 60; // 17:00

function lastSampleMins(samples) {
  if (!samples || !samples.length) return -1;
  const [h, m] = samples[samples.length - 1].time.split(":").map(Number);
  return h * 60 + m;
}

// Proxy + cache (Supabase) para as leituras de Pac (15 min) por inversor de um dia,
// usadas pelo painel de Disponibilidade. Fonte: /ingecon/samplesv2/plant/{id}/date/{date}.
// Nota: a coluna "sn" da tabela guarda o BoardId (não o SN da API) — ver comentário abaixo.
export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { date } = req.query;
  if (!date || !/^\d{8}$/.test(date)) {
    return res.status(400).json({ error: "Parâmetro 'date' inválido — use o formato YYYYMMDD" });
  }

  let supabase;
  try {
    supabase = getSupabase();
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  const isoDate = toISODate(date);
  const isToday = date === todayInPlantTz();

  if (!isToday) {
    const { data: cachedRows, error: readErr } = await supabase
      .from("ingecon_availability_daily")
      .select("sn,samples")
      .eq("date", isoDate);
    if (readErr) return res.status(500).json({ error: "Erro ao ler cache: " + readErr.message });
    if (cachedRows && cachedRows.length) {
      const maxLastMins = Math.max(...cachedRows.map(r => lastSampleMins(r.samples)));
      if (maxLastMins >= COMPLETE_THRESHOLD_MINS) {
        await lazyCleanup(supabase).catch(() => {});
        res.setHeader("Cache-Control", "public, s-maxage=86400, stale-while-revalidate=604800");
        res.setHeader("X-Cache", "HIT");
        return res.status(200).json(Object.fromEntries(cachedRows.map(r => [r.sn, r.samples])));
      }
      // Cache incompleto (dia fechado congelado no meio da tarde) — busca de novo na API,
      // que agora devolve o dia inteiro já que ele já terminou.
    }
  }

  let headers;
  try {
    headers = ingeconHeaders();
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  const url = `https://www.ingeconsunmonitor.com/api/ingecon/samplesv2/plant/${plantId()}/date/${date}`;
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
  // dois boards físicos diferentes (posições 4.4.1 e 4.1.1) — BoardId é o identificador
  // realmente único por inversor (confirmado: 30 boards distintos = 30 posições).
  const bySn = {};
  records.forEach(r => {
    if (!r.BoardId) return;
    const boardId = canonicalBoardId(r.BoardId);
    const time = String(r.DateTime || "").slice(11, 16);
    const pac = (typeof r.Pac === "number" && isFinite(r.Pac)) ? r.Pac / 1000 : null; // W -> kW
    if (!bySn[boardId]) bySn[boardId] = [];
    bySn[boardId].push({ time, pac });
  });
  Object.values(bySn).forEach(arr => arr.sort((a, b) => a.time.localeCompare(b.time)));

  const rows = Object.entries(bySn).map(([sn, samples]) => ({
    sn, date: isoDate, samples, updated_at: new Date().toISOString(),
  }));
  if (rows.length) {
    const { error: upsertErr } = await supabase
      .from("ingecon_availability_daily")
      .upsert(rows, { onConflict: "sn,date" });
    if (upsertErr) return res.status(500).json({ error: "Erro ao gravar cache: " + upsertErr.message });
  }

  await lazyCleanup(supabase).catch(() => {});

  res.setHeader("Cache-Control", isToday
    ? "public, s-maxage=60, stale-while-revalidate=300"
    : "public, s-maxage=86400, stale-while-revalidate=604800");
  res.setHeader("X-Cache", "MISS");

  return res.status(200).json(bySn);
}

import { getSupabase } from "./_lib/supabase.js";
import { plantId, ingeconHeaders, todayInPlantTz } from "./_lib/ingecon.js";

// "SM3/INV3.2.1ST" → "3.2.1"
function posFromGid(gid) {
  const m = String(gid).match(/INV(\d+)\.(\d+\.\d+)ST$/i);
  return m ? `${m[1]}.${m[2]}` : null;
}

// Últimos `count` dias já fechados, começando em ontem (hoje ainda está em andamento).
function recentDates(count) {
  const today = todayInPlantTz();
  const y = parseInt(today.slice(0, 4), 10), mo = parseInt(today.slice(4, 6), 10) - 1, d = parseInt(today.slice(6, 8), 10);
  const out = [];
  for (let i = 1; i <= count; i++) {
    const dt = new Date(Date.UTC(y, mo, d));
    dt.setUTCDate(dt.getUTCDate() - i);
    out.push(`${dt.getUTCFullYear()}${String(dt.getUTCMonth() + 1).padStart(2, "0")}${String(dt.getUTCDate()).padStart(2, "0")}`);
  }
  return out;
}

const SCAN_DAYS = 5;

// Mapeia BoardId → posição real do combinador (ex.: "3.2.1"). BoardId é o identificador
// verdadeiramente único por inversor — o serviço de stringbox já traz GId+BoardId juntos,
// então não precisa cruzar com o serviço de inversores (que tem SNs duplicados/reaproveitados).
// Um único dia às vezes não tem cobertura de 100% dos boards (falha pontual de comunicação),
// então varre os últimos dias fechados e vai completando o mapa até achar todos.
//
// O resultado é persistido em Supabase (ingecon_inverter_map): sem isso, um BoardId que fica
// mais de SCAN_DAYS dias sem comunicar (manutenção, falha prolongada etc.) simplesmente some
// do mapa reconstruído do zero a cada chamada, e o nome volta a aparecer como "SN ####" —
// mesmo já tendo sido resolvido antes. Uma vez resolvido, o board não deve mais "esquecer".
//
// A varredura ao vivo (5 chamadas sequenciais à API do INGECON) é lenta (~40s) — por isso só
// roda quando explicitamente pedida (?refresh=1, disparado pelo botão "Atualizar") ou na
// primeiríssima vez (tabela ainda vazia). Toda outra chamada só lê o cache persistido, que
// responde na hora.
export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  let supabase;
  try {
    supabase = getSupabase();
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  const { data: persisted, error: readErr } = await supabase
    .from("ingecon_inverter_map")
    .select("board_id,pos");
  if (readErr) return res.status(500).json({ error: "Erro ao ler cache: " + readErr.message });

  const map = {};
  (persisted || []).forEach(r => { map[r.board_id] = r.pos; });

  const forceRefresh = req.query.refresh === "1";
  if (!forceRefresh && Object.keys(map).length) {
    res.setHeader("Cache-Control", "public, s-maxage=86400, stale-while-revalidate=604800");
    return res.status(200).json(map);
  }

  let headers;
  try {
    headers = ingeconHeaders();
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  const found = {};
  for (const date of recentDates(SCAN_DAYS)) {
    const url = `https://www.ingeconsunmonitor.com/api/stringbox/samplesv2/plant/${plantId()}/date/${date}`;
    let sbRes;
    try {
      sbRes = await fetch(url, { headers });
      if (sbRes.status === 429) { // rate limit transitório — espera e tenta esse dia mais uma vez
        await new Promise(r => setTimeout(r, 4000));
        sbRes = await fetch(url, { headers });
      }
    } catch {
      continue;
    }
    if (!sbRes.ok) continue;
    const sbRecords = await sbRes.json();
    sbRecords.forEach(r => {
      if (!r.BoardId || !r.GId || found[r.BoardId]) return;
      const pos = posFromGid(r.GId);
      if (pos) found[r.BoardId] = pos;
    });
  }

  // Grava só board_ids novos ou cuja posição mudou (ex.: hardware trocado) — evita upsert desnecessário.
  const toUpsert = Object.entries(found)
    .filter(([boardId, pos]) => map[boardId] !== pos)
    .map(([boardId, pos]) => ({ board_id: boardId, pos, updated_at: new Date().toISOString() }));
  if (toUpsert.length) {
    const { error: upsertErr } = await supabase
      .from("ingecon_inverter_map")
      .upsert(toUpsert, { onConflict: "board_id" });
    if (upsertErr) return res.status(500).json({ error: "Erro ao gravar cache: " + upsertErr.message });
  }

  Object.assign(map, found);

  res.setHeader("Cache-Control", "public, s-maxage=86400, stale-while-revalidate=604800");
  return res.status(200).json(map);
}

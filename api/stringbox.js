import { plantId, ingeconHeaders, todayInPlantTz, canonicalGId } from "./_lib/ingecon.js";

// Proxy para GET /stringbox/samplesv2/plant/{plantId}/date/{date} do INGECON SUN Monitor.
// A API key fica só aqui no servidor — nunca é exposta ao browser.
export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { date } = req.query;
  if (!date || !/^\d{8}$/.test(date)) {
    return res.status(400).json({ error: "Parâmetro 'date' inválido — use o formato YYYYMMDD" });
  }

  let headers;
  try {
    headers = ingeconHeaders();
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  const upstreamUrl = `https://www.ingeconsunmonitor.com/api/stringbox/samplesv2/plant/${plantId()}/date/${date}`;

  let upstreamRes;
  try {
    upstreamRes = await fetch(upstreamUrl, { headers });
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

  const data = await upstreamRes.json();
  data.forEach(r => { if (r.GId) r.GId = canonicalGId(r.GId); });

  const isToday = date === todayInPlantTz();
  res.setHeader(
    "Cache-Control",
    isToday
      ? "public, s-maxage=60, stale-while-revalidate=300"
      : "public, s-maxage=86400, stale-while-revalidate=604800"
  );

  return res.status(200).json(data);
}

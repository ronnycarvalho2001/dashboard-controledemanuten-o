export const PLANT_ID_DEFAULT = "ad493847-3dd7-4526-9122-123e35d1374a";
export const PLANT_TZ = "America/Fortaleza";

export function todayInPlantTz() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: PLANT_TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${map.year}${map.month}${map.day}`;
}

export function plantId() {
  return process.env.INGECON_PLANT_ID || PLANT_ID_DEFAULT;
}

export function ingeconHeaders() {
  const apiKey = process.env.INGECON_API_KEY;
  if (!apiKey) throw new Error("INGECON_API_KEY não configurada no servidor");
  return { "X-API-KEY": apiKey, "Accept-Encoding": "gzip" };
}

export function toISODate(yyyymmdd) {
  return `${yyyymmdd.slice(0,4)}-${yyyymmdd.slice(4,6)}-${yyyymmdd.slice(6,8)}`;
}

// BoardIds que substituíram um board antigo na mesma posição física (troca de placa/gateway
// após falha) — mapeados de volta pro id antigo, pra série de geração/disponibilidade
// continuar contínua em vez do board novo aparecer como um 31º inversor "órfão" (sem posição
// resolvida, já que o novo gateway reporta um GId em formato diferente do stringbox).
//
// 0FM242733A02 (GId "group1/device2") → 0FM222805A32 (posição 4.4.2): a placa antiga gerou
// normalmente todo dia desde 01/08/2026, caiu a 0 em 04/09 e parou de reportar (sem amostras
// entre 05/09 e 07/09); a placa nova passou a reportar em 08/09 com geração diária na mesma
// faixa histórica da 4.4.2 (~19-26 MWh).
const BOARD_ID_ALIASES = {
  "0FM242733A02": "0FM222805A32",
};
export function canonicalBoardId(boardId) {
  return BOARD_ID_ALIASES[boardId] || boardId;
}

// A placa nova da posição 4.4.2 (board 0FM242733A02, ver alias acima) reporta o stringbox
// com GId genérico "group1/device2" em vez do formato usual "SMx/INVx.y.zST" — sem isso, a
// combiner some do agrupamento por inversor (combinerMeta/posFromGid não reconhecem o
// formato) e herda a contagem errada de canais (17 em vez de 16, já que ".2" é par).
const GID_ALIASES = {
  "group1/device2": "SM4/INV4.4.2ST",
};
export function canonicalGId(gid) {
  return GID_ALIASES[gid] || gid;
}

import { createClient } from "@supabase/supabase-js";

let client = null;

export function getSupabase() {
  if (!client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error("Supabase não configurado no servidor");
    client = createClient(url, key, { auth: { persistSession: false } });
  }
  return client;
}

// Mantém só "mês atual + 7 dias de tolerância" (~37 dias) — cobre a mesma janela
// que a própria API do INGECON expõe, sem precisar de lógica de calendário nem cron dedicado.
const RETENTION_DAYS = 37;

export async function lazyCleanup(supabase) {
  if (Math.random() > 0.05) return;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  await Promise.all([
    supabase.from("ingecon_generation_daily").delete().lt("date", cutoffStr),
    supabase.from("ingecon_availability_daily").delete().lt("date", cutoffStr),
  ]);
}

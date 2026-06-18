import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Se as variáveis de ambiente não estiverem configuradas, o app continua
// funcionando localmente (sem persistir/sincronizar nada) — útil para
// rodar e testar antes de configurar o Supabase.
export const supabase = url && key ? createClient(url, key) : null;

if (!supabase) {
  console.warn(
    "[Supabase] VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY não configuradas. " +
    "O dashboard vai funcionar, mas não vai salvar nem sincronizar o status dos trackers. " +
    "Veja o README.md para configurar."
  );
}

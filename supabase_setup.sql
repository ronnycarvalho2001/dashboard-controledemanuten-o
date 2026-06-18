-- Execute este script no SQL Editor do seu projeto Supabase
-- (Painel do Supabase > SQL Editor > New query > colar e Run)

create table if not exists tracker_status (
  id text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Habilita Row Level Security (recomendado mesmo em projeto interno)
alter table tracker_status enable row level security;

-- Política simples: qualquer pessoa com a chave anon pode ler e escrever.
-- Isso é adequado para uma ferramenta interna de equipe usada via link
-- privado. Se quiser restringir mais (ex: exigir login), troque estas
-- políticas por regras baseadas em auth.uid().
create policy "tracker_status: allow read" on tracker_status
  for select using (true);

create policy "tracker_status: allow insert" on tracker_status
  for insert with check (true);

create policy "tracker_status: allow update" on tracker_status
  for update using (true);

-- Habilita Realtime para esta tabela, para que o status marcado por uma
-- pessoa apareça automaticamente para as outras sem precisar recarregar a
-- página. (Equivalente a fazer isso manualmente em Database > Replication
-- no painel, marcando "tracker_status".)
alter publication supabase_realtime add table tracker_status;

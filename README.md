# UFV SDM — Dashboard de Campo (Lavagem, Roçagem & Acesso)

Dashboard React para marcar e acompanhar o status de lavagem, roçagem e
acesso de trator dos 1.980 trackers (15 subcampos × 132 trackers) da usina,
com posições reais extraídas do mapa de coordenadas. Os dados ficam salvos
no Supabase e sincronizam em tempo real entre todas as pessoas que abrirem
o link.

## 1. Pré-requisitos

- [Node.js](https://nodejs.org) 18 ou superior
- Uma conta no [Supabase](https://supabase.com) (gratuita)
- Uma conta no [GitHub](https://github.com)
- Uma conta na [Vercel](https://vercel.com)

## 2. Configurar o Supabase

1. Crie um projeto novo em [supabase.com](https://supabase.com/dashboard).
2. Vá em **SQL Editor** → **New query**, cole o conteúdo do arquivo
   [`supabase_setup.sql`](./supabase_setup.sql) deste projeto e clique em
   **Run**. Isso cria a tabela `tracker_status` e já habilita leitura,
   escrita e sincronização em tempo real.
3. Vá em **Project Settings → API** e copie:
   - **Project URL**
   - **anon public key**

> ⚠️ A política de acesso criada no script é aberta (qualquer pessoa com o
> link do app e a chave anon consegue ler/escrever). Isso é adequado para
> uma ferramenta interna usada por um link privado da equipe. Se quiser
> exigir login antes de marcar status, me avise — dá para adicionar
> autenticação do Supabase depois.

## 3. Rodar localmente

```bash
npm install
cp .env.example .env
# edite o .env e cole a Project URL e a anon key copiadas no passo 2
npm run dev
```

Abra o endereço que aparecer no terminal (geralmente
`http://localhost:5173`). Se o `.env` não estiver configurado, o app ainda
abre e funciona, só não salva nem sincroniza nada (aparece um aviso amarelo
"Sem Supabase configurado" no topo).

## 4. Subir para o GitHub

```bash
git init
git add .
git commit -m "Dashboard SDM - lavagem, roçagem e acesso"
git branch -M main
git remote add origin https://github.com/SEU-USUARIO/SEU-REPOSITORIO.git
git push -u origin main
```

(Crie o repositório vazio antes no GitHub, em github.com/new — sem README,
sem .gitignore, sem licença, para não dar conflito ao fazer o primeiro push.)

## 5. Deploy na Vercel

1. Em [vercel.com/new](https://vercel.com/new), importe o repositório que
   você acabou de subir.
2. A Vercel detecta automaticamente que é um projeto Vite (build command
   `vite build`, output `dist`) — não precisa mudar nada.
3. Antes de clicar em Deploy, abra **Environment Variables** e adicione:
   - `VITE_SUPABASE_URL` → a Project URL do Supabase
   - `VITE_SUPABASE_ANON_KEY` → a anon public key do Supabase
4. Clique em **Deploy**.

Pronto — o link gerado pela Vercel já é o dashboard funcionando para a
equipe toda, com os dados compartilhados em tempo real via Supabase.

## Estrutura do projeto

```
sdm-dashboard/
├── index.html
├── package.json
├── vite.config.js
├── supabase_setup.sql      ← script para criar a tabela no Supabase
├── .env.example            ← copiar para .env com suas chaves
└── src/
    ├── main.jsx
    ├── index.css
    ├── supabaseClient.js   ← conexão com o Supabase
    └── App.jsx             ← dashboard completo (mapas, camadas, etc.)
```

## Observações

- As coordenadas dos trackers, grupos e unidades NCU/RSU estão embutidas
  diretamente em `src/App.jsx` (vindas do `Mapa_Coordenadas_-_QAIR_-_UFV_SDM.xlsx`).
  Se a planta for atualizada/remapeada no futuro, esses dados precisam ser
  regerados a partir da planilha nova.
- A geometria de vias de acesso / pad de inversor não está representada —
  só trackers, contornos de grupo e unidades de comando, por falta de dados
  de coordenadas dessas áreas.

Trabalho de Gerencia de Projetos (Sem data prevista de entrega).

`TAP_Drive_Flex.docx` é um exemplo do documento a ser gerado.

## Como rodar localmente

1. Instale Node.js 18+.
2. Instale as dependências:
   ```bash
   npm install
   ```
3. Copie o `.env.example` para `.env` e coloque sua chave do Gemini:
   ```bash
   cp .env.example .env
   # edite .env e preencha GEMINI_API_KEY=...
   ```
   A chave pode ser obtida em https://aistudio.google.com/app/apikey
4. Inicie o servidor:
   ```bash
   npm start
   ```
5. Abra http://localhost:3000 no navegador.

## Endpoints

- `GET /` — serve o `gerador_tap.html`.
- `GET /api/health` — status do servidor (mostra se a chave está configurada).
- `POST /api/generate` — recebe os dados do canvas e devolve JSON enriquecido pela IA (Gemini).

## Deploy na web

O projeto é um único serviço Node (Express) que serve o HTML estático e o endpoint da IA. Funciona direto em qualquer PaaS (Render, Railway, Fly.io, etc.):

- Build command: `npm install`
- Start command: `npm start`
- Variáveis de ambiente: `GEMINI_API_KEY` (obrigatória), opcionalmente `GEMINI_MODEL` e `PORT`.

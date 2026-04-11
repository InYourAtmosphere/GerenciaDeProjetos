import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

// ── Guards: limites configuráveis via .env ───────────────────────
const MAX_FIELD_CHARS   = Number(process.env.MAX_FIELD_CHARS   || 3000);   // por campo
const MAX_TOTAL_CHARS   = Number(process.env.MAX_TOTAL_CHARS   || 20000);  // payload inteiro
const RATE_WINDOW_MS    = Number(process.env.RATE_WINDOW_MS    || 10 * 60 * 1000); // 10 min
const RATE_MAX_PER_IP   = Number(process.env.RATE_MAX_PER_IP   || 5);      // req por IP/janela
const DAILY_GLOBAL_MAX  = Number(process.env.DAILY_GLOBAL_MAX  || 20);    // teto global/dia
const ALLOWED_ORIGIN    = process.env.ALLOWED_ORIGIN || '';                // ex.: https://seu-app.onrender.com

app.set('trust proxy', 1); // necessário em PaaS p/ req.ip correto
app.use(express.json({ limit: '64kb' }));
app.use(express.static(__dirname));

// ── Rate limit em memória (sem dependências) ─────────────────────
const ipHits = new Map(); // ip -> { count, resetAt }
let dayKey = new Date().toISOString().slice(0, 10);
let dayCount = 0;

function rateLimit(req, res, next) {
  // Reset da cota diária
  const today = new Date().toISOString().slice(0, 10);
  if (today !== dayKey) { dayKey = today; dayCount = 0; }

  if (dayCount >= DAILY_GLOBAL_MAX) {
    return res.status(429).json({ error: 'Cota diária global atingida. Tente novamente amanhã.' });
  }

  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const entry = ipHits.get(ip);
  if (!entry || now > entry.resetAt) {
    ipHits.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
  } else {
    entry.count++;
    if (entry.count > RATE_MAX_PER_IP) {
      const retry = Math.ceil((entry.resetAt - now) / 1000);
      res.set('Retry-After', String(retry));
      return res.status(429).json({ error: `Muitas requisições. Tente novamente em ${retry}s.` });
    }
  }
  next();
}

// Limpa entradas expiradas a cada 5 min para não vazar memória
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of ipHits) if (now > e.resetAt) ipHits.delete(ip);
}, 5 * 60 * 1000).unref();

function checkOrigin(req, res, next) {
  if (!ALLOWED_ORIGIN) return next(); // se não configurado, libera (dev local)
  const origin = req.get('origin') || req.get('referer') || '';
  if (!origin.startsWith(ALLOWED_ORIGIN)) {
    return res.status(403).json({ error: 'Origem não permitida.' });
  }
  next();
}

function validatePayload(data) {
  const fields = ['nome','justificativa','objetivo','produto','requisitos','exclusoes',
                  'premissas','restricoes','beneficios','custos'];
  for (const f of fields) {
    if (typeof data[f] === 'string' && data[f].length > MAX_FIELD_CHARS) {
      return `Campo "${f}" excede ${MAX_FIELD_CHARS} caracteres.`;
    }
  }
  // Limita arrays (stakes/team/risks/phases) a 30 itens cada
  for (const f of ['stakes','team','risks','phases']) {
    if (Array.isArray(data[f]) && data[f].length > 30) {
      return `Lista "${f}" excede 30 itens.`;
    }
  }
  if (JSON.stringify(data).length > MAX_TOTAL_CHARS) {
    return `Payload total excede ${MAX_TOTAL_CHARS} caracteres.`;
  }
  return null;
}

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'gerador_tap.html'));
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, hasKey: Boolean(GEMINI_API_KEY), model: GEMINI_MODEL });
});

app.post('/api/generate', checkOrigin, rateLimit, async (req, res) => {
  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: 'GEMINI_API_KEY não configurada no .env do servidor.' });
  }

  const data = req.body || {};
  if (!data.nome || !data.objetivo) {
    return res.status(400).json({ error: 'Campos obrigatórios ausentes (nome, objetivo).' });
  }

  const invalid = validatePayload(data);
  if (invalid) return res.status(413).json({ error: invalid });

  dayCount++; // conta antes da chamada para bloquear abuso mesmo em falhas
  const prompt = buildPrompt(data);

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    const gemResp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 8192,
          responseMimeType: 'application/json'
        }
      })
    });

    if (!gemResp.ok) {
      const errText = await gemResp.text();
      return res.status(502).json({ error: `Gemini API ${gemResp.status}`, details: errText });
    }

    const gemJson = await gemResp.json();
    const text = gemJson?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const cleaned = text.replace(/```json|```/g, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      return res.status(502).json({ error: 'Resposta da IA não é JSON válido.', raw: cleaned });
    }

    res.json(parsed);
  } catch (err) {
    res.status(500).json({ error: 'Falha ao chamar Gemini', details: String(err?.message || err) });
  }
});

function buildPrompt(data) {
  return `Você é um especialista em gerência de projetos (PMBOK). Com base nos dados do Project Model Canvas abaixo, expanda cada seção em texto formal e profissional para compor o TAP (Termo de Abertura do Projeto). Retorne APENAS um JSON válido com as chaves abaixo, sem markdown.

DADOS DO CANVAS:
- Projeto: ${data.nome}
- Justificativa: ${data.justificativa || ''}
- Objetivo: ${data.objetivo || ''}
- Produto: ${data.produto || ''}
- Requisitos: ${data.requisitos || ''}
- Exclusões: ${data.exclusoes || ''}
- Premissas: ${data.premissas || ''}
- Restrições: ${data.restricoes || ''}
- Benefícios: ${data.beneficios || ''}
- Custos: ${data.custos || ''}
- Stakeholders: ${JSON.stringify(data.stakes || [])}
- Equipe: ${JSON.stringify(data.team || [])}
- Riscos: ${JSON.stringify(data.risks || [])}
- Fases: ${JSON.stringify(data.phases || [])}

Retorne JSON com estas chaves (todas as strings em português formal, 2-4 parágrafos quando indicado):
{
  "justificativa_expandida": "texto formal com 2-3 parágrafos expandindo a justificativa",
  "objetivo_expandido": "texto formal com 1-2 parágrafos expandindo o objetivo SMART",
  "produto_expandido": "texto formal descrevendo o produto/solução em 1-2 parágrafos",
  "premissas_lista": ["premissa 1 formal", "premissa 2 formal"],
  "restricoes_lista": ["restrição 1 formal", "..."],
  "beneficios_lista": ["benefício 1 formal", "..."],
  "custos_lista": ["categoria: descrição", "..."],
  "autorizacao": "parágrafo formal de autorização do projeto",
  "nota_risco": "frase curta sobre plano completo de riscos no planejamento",
  "nota_orcamento": "frase curta sobre valores serem definidos no planejamento"
}`;
}

app.listen(PORT, () => {
  console.log(`TAP Builder rodando em http://localhost:${PORT}`);
  if (!GEMINI_API_KEY) console.warn('Aviso: GEMINI_API_KEY ausente — /api/generate retornará erro.');
});

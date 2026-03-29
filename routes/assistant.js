const express = require('express');
const https = require('https');
const { Pool } = require('pg');
const auth = require('../middleware/auth');

const router = express.Router();
const db = new Pool({ connectionString: process.env.DATABASE_URL });
const DEFAULT_ASSISTANT_MODEL = 'gpt-4o-mini';

function resolveAssistantModel() {
  const rawModel = (process.env.OPENAI_MODEL || '').trim();
  if (!rawModel) return DEFAULT_ASSISTANT_MODEL;

  const allowedPrefixes = ['gpt-4o', 'gpt-4.1'];
  return allowedPrefixes.some(prefix => rawModel.startsWith(prefix))
    ? rawModel
    : DEFAULT_ASSISTANT_MODEL;
}

function buildMissionContext(mission, checkins, question) {
  const recentNotes = checkins
    .filter(item => item.completed && item.note && item.note.trim())
    .sort((a, b) => b.day_number - a.day_number)
    .slice(0, 5)
    .map(item => `Dia ${item.day_number}: ${item.note}`)
    .join('\n');

  return `
Tu es o Assistente da Missao do Nexus.
Responde sempre em portugues do Brasil.
Fala de forma humana, direta e curta.
Nao uses emojis.
Nao fales de outras missoes.
Nao inventes progresso que nao existe.
Ajuda a pessoa a executar a missao de hoje.

Missao atual:
- titulo: ${mission.title}
- categoria: ${mission.category}
- modo: ${mission.mode}
- nivel: ${mission.level}
- minimo diario: ${mission.daily_minimum || 'nao definido'}
- janela: ${mission.commitment_window || 'nao definida'}
- porque importa: ${mission.why_it_matters || 'nao definido'}
- plano se falhar: ${mission.fallback_plan || 'nao definido'}
- prova: ${mission.proof_mode || 'self_report'}
- estudo foco: ${mission.study_focus || 'nao se aplica'}
- estudo etapa atual: ${mission.study_current_stage || 'nao se aplica'}
- estudo objetivo de 30 dias: ${mission.study_target_outcome || 'nao se aplica'}

Notas/check-ins recentes:
${recentNotes || 'Sem notas recentes.'}

Pergunta do usuario:
${question}

Formato da resposta:
1. responde a pergunta
2. se fizer sentido, diz exatamente o que fazer hoje
3. se fizer sentido, diz o proximo passo de amanha
`;
}

function extractResponseText(payload) {
  if (payload.output_text) return payload.output_text.trim();
  if (!Array.isArray(payload.output)) return '';

  return payload.output
    .flatMap(item => Array.isArray(item.content) ? item.content : [])
    .map(item => {
      if (item.type === 'output_text' && item.text) return item.text;
      if (item.type === 'text' && item.text?.value) return item.text.value;
      return '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function callOpenAI(prompt) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.OPENAI_API_KEY;
    const model = resolveAssistantModel();

    const body = JSON.stringify({
      model,
      input: [
        {
          role: 'system',
          content: [
            {
              type: 'input_text',
              text: 'Tu es o Grande Irmao do Nexus. Responde com firmeza, clareza e sem entusiasmo falso.'
            }
          ]
        },
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: prompt
            }
          ]
        }
      ],
      max_output_tokens: 220
    });

    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/responses',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': `Bearer ${apiKey}`
      }
    }, res => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(raw || '{}');
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(json.error?.message || 'Falha na OpenAI.'));
          }

          const text = extractResponseText(json);
          if (!text) {
            return reject(new Error('A OpenAI nao devolveu texto.'));
          }

          resolve({ text, model });
        } catch (err) {
          reject(err);
        }
      });
    });

    req.setTimeout(20000, () => {
      req.destroy(new Error('Timeout ao chamar a OpenAI.'));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function buildHealthPayload(live = false) {
  const configured = Boolean(process.env.OPENAI_API_KEY);
  const modelRequested = (process.env.OPENAI_MODEL || '').trim() || null;
  const modelResolved = resolveAssistantModel();

  const payload = {
    configured,
    model_requested: modelRequested,
    model_resolved: modelResolved,
    using_default_model: modelResolved === DEFAULT_ASSISTANT_MODEL && modelRequested !== DEFAULT_ASSISTANT_MODEL
  };

  if (!live || !configured) return payload;

  const result = await callOpenAI('Responde so com: online');
  return {
    ...payload,
    live: true,
    assistant_reply: result.text
  };
}

router.get('/health', auth, async (req, res) => {
  if (req.user.userId !== 1) {
    return res.status(403).json({ error: 'Nao autorizado.' });
  }

  try {
    const live = String(req.query.live || '') === '1';
    const payload = await buildHealthPayload(live);
    res.json(payload);
  } catch (err) {
    res.status(500).json({
      configured: Boolean(process.env.OPENAI_API_KEY),
      model_requested: (process.env.OPENAI_MODEL || '').trim() || null,
      model_resolved: resolveAssistantModel(),
      live: true,
      error: err.message
    });
  }
});

router.post('/mission', auth, async (req, res) => {
  const userId = req.user.userId;
  const missionId = Number(req.body.mission_id);
  const question = (req.body.question || '').trim();

  if (!process.env.OPENAI_API_KEY) {
    return res.status(503).json({ error: 'assistant_unavailable', message: 'Assistente IA ainda nao configurado.' });
  }

  if (!missionId || !question) {
    return res.status(400).json({ error: 'mission_id e question sao obrigatorios.' });
  }

  try {
    const missionRes = await db.query(
      `SELECT *
       FROM missions
       WHERE id = $1
         AND (user_id = $2 OR partner_id = $2)
       LIMIT 1`,
      [missionId, userId]
    );

    const mission = missionRes.rows[0];
    if (!mission) {
      return res.status(404).json({ error: 'Missao nao encontrada.' });
    }

    const checkinsRes = await db.query(
      `SELECT day_number, completed, note
       FROM checkins
       WHERE mission_id = $1
         AND user_id = $2
       ORDER BY day_number DESC
       LIMIT 10`,
      [missionId, userId]
    );

    const prompt = buildMissionContext(mission, checkinsRes.rows, question);
    const result = await callOpenAI(prompt);

    res.json({
      answer: result.text,
      source: 'openai',
      model: result.model
    });
  } catch (err) {
    console.error('Assistant error:', err.message);
    res.status(500).json({
      error: 'assistant_failed',
      message: 'Nao foi possivel gerar resposta agora.',
      details: err.message
    });
  }
});

module.exports = router;

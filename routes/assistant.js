const express = require('express');
const https = require('https');
const { Pool } = require('pg');
const auth = require('../middleware/auth');

const router = express.Router();
const db = new Pool({ connectionString: process.env.DATABASE_URL });

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
    .filter(item => item.type === 'output_text' && item.text)
    .map(item => item.text)
    .join('\n')
    .trim();
}

function callOpenAI(prompt) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.OPENAI_API_KEY;
    const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

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

          resolve(text);
        } catch (err) {
          reject(err);
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

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
    const answer = await callOpenAI(prompt);

    res.json({ answer });
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

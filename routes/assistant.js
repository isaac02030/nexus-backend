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
    .map(item => `Dia ${item.day_number}: ${String(item.note).slice(0, 280)}`)
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

function getLastCompletedNote(checkins) {
  return checkins.find(item => item.completed && item.note && item.note.trim());
}

function buildLocalAssistantFallback(mission, checkins, question) {
  const q = String(question || '').toLowerCase();
  const minimum = mission.daily_minimum || 'o minimo combinado';
  const fallback = mission.fallback_plan || 'faz a versao minima e volta amanha sem negociar.';
  const why = mission.why_it_matters || 'ha uma palavra tua para proteger.';
  const lastNote = getLastCompletedNote(checkins);

  if (mission.category === 'aprendizagem') {
    const focus = mission.study_focus || mission.title;
    const stage = mission.study_current_stage || 'base';
    const target = mission.study_target_outcome || 'fechar um bloco concreto em 30 dias';

    if (q.includes('3 dias') || q.includes('tres dias') || q.includes('plano')) {
      return [
        `Hoje: fecha ${minimum} em ${focus}, focando em ${stage}.`,
        `A entrega de hoje e uma nota curta com o que entendeste e o que ainda ficou confuso.`,
        `Amanha: revisa o que assentou hoje e avanca um passo em direcao a ${target}.`
      ].join(' ');
    }

    if (q.includes('nota')) {
      return 'Escreve a nota em tres partes: o que estudaste, o que ficou claro e o que ainda precisas rever amanha.';
    }

    if (q.includes('perdido') || q.includes('trav')) {
      return `Nao tenta resolver a missao inteira agora. Hoje fecha so ${minimum} em ${focus}, a partir de ${stage}. No fim, deixa uma nota curta.`;
    }

    return `Hoje fecha ${minimum} em ${focus}, comecando por ${stage}. No fim, escreve uma nota curta e usa isso para decidir o passo de amanha.`;
  }

  if (mission.category === 'fitness') {
    if (q.includes('prova')) {
      return 'Faz o treino combinado e registra uma prova curta: tipo de treino, duracao ou distancia, e uma nota objetiva do que foi feito.';
    }

    if (q.includes('3 dias') || q.includes('tres dias') || q.includes('plano')) {
      return [
        `Hoje: fecha ${minimum} e registra a prova.`,
        'Amanha: repete o minimo ou faz uma versao mais leve se o corpo pedir ajuste.',
        'No terceiro dia: volta ao ritmo normal sem quebrar a janela combinada.'
      ].join(' ');
    }

    if (q.includes('sem vontade') || q.includes('trav')) {
      return `Nao negocia a presenca. Se o dia estiver pesado, faz a versao minima de ${minimum} e registra a prova mesmo assim.`;
    }

    return `Hoje o foco e simples: fecha ${minimum} dentro da janela combinada e registra uma prova curta do treino.`;
  }

  if (mission.category === 'criatividade') {
    return `Hoje nao tenta produzir algo perfeito. Fecha ${minimum}, gera uma saida concreta e registra o que saiu. Se travares, reduz a escala, nao a presenca.`;
  }

  if (mission.category === 'habito') {
    return `Hoje protege o padrao. Fecha ${minimum} na janela combinada. Se falhares, responde com isto: ${fallback}`;
  }

  if (q.includes('por que') || q.includes('porque')) {
    return `Isto importa por uma razao simples: ${why}`;
  }

  if (lastNote) {
    return `O ultimo registro util foi no dia ${lastNote.day_number}. Usa isso como ponto de partida e fecha hoje ${minimum}.`;
  }

  return `Hoje fecha ${minimum}. Se travar, nao improvisa: ${fallback}`;
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

  if (!missionId || !question) {
    return res.status(400).json({ error: 'mission_id e question sao obrigatorios.' });
  }
  if (question.length > 500) {
    return res.status(400).json({ error: 'A pergunta ficou longa demais.' });
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

    if (!process.env.OPENAI_API_KEY) {
      return res.json({
        answer: buildLocalAssistantFallback(mission, checkinsRes.rows, question),
        source: 'fallback',
        model: null,
        fallback_reason: 'missing_api_key'
      });
    }

    try {
      const result = await callOpenAI(prompt);
      return res.json({
        answer: result.text,
        source: 'openai',
        model: result.model
      });
    } catch (openAiErr) {
      console.error('Assistant OpenAI error:', openAiErr.message);
      return res.json({
        answer: buildLocalAssistantFallback(mission, checkinsRes.rows, question),
        source: 'fallback',
        model: null,
        fallback_reason: openAiErr.message
      });
    }
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

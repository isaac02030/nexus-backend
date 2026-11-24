// ============================================
// NEXUS — Portão 18+ da comunidade
//
// Tudo da comunidade (routes/communities.js, menos as rotas de admin, e
// routes/community-missions.js inteiro) exige 18+ confirmado no cadastro:
// users.adult_confirmed_at preenchido.
//
// A coluna é lida por to_jsonb: sem a migração 006, ninguém aparece
// confirmado e a comunidade fica fechada (falha para o lado seguro).
//
// Crise vem antes: quem não confirmou 18+ e manda texto com sinal de crise
// (content do post ou details da denúncia) recebe a ajuda, não o 403. O
// pedido para aqui: nada segue para a rota e nada é gravado. Quem confirmou
// segue para a rota, que tem o próprio filtro de crise.
// ============================================

const auth = require('../middleware/auth');
const { classifyNote } = require('./crisis-filter');

const ADULT_REQUIRED_CODE = 'adult_confirmation_required';
const ADULT_REQUIRED_MESSAGE = 'A comunidade é só para maiores de 18 anos. Confirme sua idade para entrar, ler, publicar ou denunciar.';
const ADULT_GATE_CRISIS_MESSAGE = 'Nada foi enviado. Se você está passando por um momento difícil, veja os contatos de ajuda abaixo.';
const ADULT_GATE_ERROR_MESSAGE = 'Não deu para abrir a comunidade agora. Tente de novo daqui a pouco.';

const CRISIS_TEXT_FIELDS = ['content', 'details'];

function adultRequiredBody() {
  return {
    error: ADULT_REQUIRED_MESSAGE,
    code: ADULT_REQUIRED_CODE,
    adult_confirmation_required: true
  };
}

// Nível de crise mais alto entre os campos de texto, ou null.
function crisisLevelOfBody(body) {
  if (!body || typeof body !== 'object') return null;
  let level = null;
  for (const field of CRISIS_TEXT_FIELDS) {
    if (typeof body[field] !== 'string') continue;
    const found = classifyNote(body[field]);
    if (found === 'alto') return 'alto';
    if (found) level = found;
  }
  return level;
}

function makeAdultGate(db) {
  async function hasAdultConfirmation(userId) {
    const result = await db.query(
      `SELECT (to_jsonb(users) ->> 'adult_confirmed_at') IS NOT NULL AS adult_confirmed
       FROM users
       WHERE id = $1`,
      [userId]
    );
    return result.rows[0]?.adult_confirmed === true;
  }

  async function requireAdult(req, res, next) {
    const crisisLevel = crisisLevelOfBody(req.body);
    const crisisHelp = () => res.status(200).json({
      saved: false,
      crisis: true,
      crisis_level: crisisLevel,
      message: ADULT_GATE_CRISIS_MESSAGE,
      code: ADULT_REQUIRED_CODE
    });
    let adult;
    try {
      adult = await hasAdultConfirmation(req.user.userId);
    } catch (err) {
      // Sem log: nada do pedido vai para o console. Com crise, a ajuda vem
      // mesmo se o banco falhar.
      if (crisisLevel) return crisisHelp();
      return res.status(500).json({ error: ADULT_GATE_ERROR_MESSAGE });
    }
    if (adult) return next();
    if (crisisLevel) return crisisHelp();
    return res.status(403).json(adultRequiredBody());
  }

  // Login + 18+, para router.use.
  return { hasAdultConfirmation, requireAdult, gate: [auth, requireAdult] };
}

module.exports = {
  ADULT_REQUIRED_CODE,
  ADULT_REQUIRED_MESSAGE,
  adultRequiredBody,
  crisisLevelOfBody,
  makeAdultGate
};

// ============================================
// NEXUS — Excluir a conta (dados da pessoa)
//
// Base: legal/privacidade-beta-1.md, seção 9 (privado do conselho). Apaga
// conta, e-mail, senha, confirmação 18+, lembrete, contratos e missões,
// check-ins e notas, mensagens, contato da Porta Aberta, inscrições de push,
// registro de avisos, posts e denúncias feitas pela pessoa, e (migração 011)
// bloqueios e denúncias do chat.
//
// Tudo numa transação só (o chamador abre e fecha). Os comandos são
// explícitos, sem depender só do ON DELETE CASCADE, para nada ficar órfão
// e para a lista ser lida e testada num lugar só.
//
// Regras (decisão de 22/11, excluir conta):
// - Missão de que a pessoa é DONA, com parceiro (Duo na mesma missão):
//   passa ao parceiro, que fica com os check-ins, notas e mensagens dele.
//   Os textos do contrato de quem saiu viram NULL e o título vira um texto
//   neutro fixo. A missão vira solo. started_at NÃO muda: os dias de todos
//   os check-ins já gravados foram contados a partir dele (lib/mission-days).
// - Missão de que a pessoa é dona, sem parceiro, ou que está ou esteve num
//   par por mission_matches (o outro tem a missão dele): sai inteira.
// - Missão do OUTRO em que a pessoa era parceira: fica para o dono, como
//   no fim de um par (routes/missions.js, endLinkedMissionMatch): vira solo,
//   sem parceiro, e o contato da Porta Aberta de quem saiu é apagado.
// - Par por mission_matches ativo com uma missão da pessoa: a missão do
//   outro lado também vira solo, sem parceiro (como endLinkedMissionMatch).
// - Denúncias recebidas nos posts da pessoa saem com os posts.
// - Comunidade e missão de comunidade criadas pela pessoa ficam para os
//   outros membros, sem autor (created_by NULL).
// Nenhum texto da pessoa é registrado em log.

// Título da missão que passa ao parceiro (texto para o sim do dono do
// projeto). Constante fixa: entra no SQL como literal, sem dado de ninguém.
const TRANSFERRED_MISSION_TITLE = 'Missão sem título';

if (/'/.test(TRANSFERRED_MISSION_TITLE)) {
  throw new Error('TRANSFERRED_MISSION_TITLE não pode ter aspas simples.');
}

// Campos de parceiro zerados (mesmo molde de endLinkedMissionMatch).
const CLEAR_PARTNER = `partner_id = NULL,
              partner_contact = NULL,
              partner_score = 0,
              partner_started_at = NULL,
              pair_started_at = NULL,
              match_preference = NULL,
              mode = 'solo'`;
// ============================================

// Cada passo recebe só o id da pessoa ($1). A ordem importa: primeiro o que
// aponta para as missões e posts da pessoa, depois as próprias linhas.
const ACCOUNT_DELETION_STEPS = [
  {
    // Migração 013: o assunto da missão é texto livre de quem saiu. Na missão
    // que vai passar ao parceiro (mesma condição do passo seguinte), ele vira
    // NULL ANTES da troca de dono, enquanto ainda dá para achar a missão pelo
    // user_id. A área fica: é só a classificação da missão que o parceiro
    // continua. Antes da 013 a coluna não existe (optional, 42703).
    name: 'assunto_das_missoes_passadas',
    optional: true,
    missingCodes: ['42703'],
    sql: `UPDATE missions
          SET subject = NULL
          WHERE user_id = $1
            AND partner_id IS NOT NULL
            AND partner_id <> $1
            AND NOT EXISTS (
              SELECT 1 FROM mission_matches mm
              WHERE mm.mission_a_id = missions.id OR mm.mission_b_id = missions.id
            )`
  },
  {
    // Duo, dono sai: a missão passa ao parceiro, sem o contrato de quem saiu.
    // Só o Duo de verdade (o parceiro na MESMA missão). Missão que está ou
    // esteve num par por mission_matches NÃO passa: no par, routes/missions.js
    // grava partner_id nas duas missões e o outro já tem a dele (achado do
    // Argos no PR 26); ela sai inteira, como solo.
    // É o PRIMEIRO passo: precisa ver os pares antes de eles serem apagados,
    // e os passos seguintes só pegam o que ainda é da pessoa.
    name: 'missoes_passadas_ao_parceiro',
    sql: `UPDATE missions
          SET user_id = partner_id,
              user_score = partner_score,
              user_contact = partner_contact,
              title = '${TRANSFERRED_MISSION_TITLE}',
              description = NULL,
              daily_minimum = NULL,
              commitment_window = NULL,
              why_it_matters = NULL,
              fallback_plan = NULL,
              study_focus = NULL,
              study_current_stage = NULL,
              study_target_outcome = NULL,
              ${CLEAR_PARTNER}
          WHERE user_id = $1
            AND partner_id IS NOT NULL
            AND partner_id <> $1
            AND NOT EXISTS (
              SELECT 1 FROM mission_matches mm
              WHERE mm.mission_a_id = missions.id OR mm.mission_b_id = missions.id
            )`
  },
  {
    // Só pares ATIVOS: um par antigo, já encerrado, não mexe numa missão do
    // outro que hoje pode estar em outro par.
    name: 'missao_do_outro_lado_do_par',
    sql: `UPDATE missions
          SET ${CLEAR_PARTNER}
          WHERE (user_id IS NULL OR user_id <> $1)
            AND id IN (
              SELECT CASE WHEN mm.mission_a_id IN (SELECT id FROM missions WHERE user_id = $1)
                          THEN mm.mission_b_id ELSE mm.mission_a_id END
              FROM mission_matches mm
              WHERE mm.status = 'active'
                AND (mm.mission_a_id IN (SELECT id FROM missions WHERE user_id = $1)
                  OR mm.mission_b_id IN (SELECT id FROM missions WHERE user_id = $1))
            )`
  },
  {
    // A missão passada ao parceiro não tem par (ver o 1.º passo): todos os
    // pares que sobram são de missões que ainda são da pessoa.
    name: 'pares_das_missoes',
    sql: `DELETE FROM mission_matches
          WHERE mission_a_id IN (SELECT id FROM missions WHERE user_id = $1)
             OR mission_b_id IN (SELECT id FROM missions WHERE user_id = $1)`
  },
  {
    name: 'missoes_do_outro_sem_parceiro',
    sql: `UPDATE missions
          SET ${CLEAR_PARTNER}
          WHERE partner_id = $1
            AND (user_id IS NULL OR user_id <> $1)`
  },
  {
    name: 'fusoes_apontando_para_as_missoes',
    sql: `UPDATE missions
          SET merged_into_id = NULL
          WHERE merged_into_id IN (SELECT id FROM missions WHERE user_id = $1)`
  },
  {
    name: 'checkins',
    sql: `DELETE FROM checkins
          WHERE user_id = $1
             OR mission_id IN (SELECT id FROM missions WHERE user_id = $1)`
  },
  {
    // Migração 011 (chat): denúncias feitas pela pessoa e as feitas sobre as
    // mensagens que vão sair (as dela e as das missões dela). Antes da 011 a
    // tabela não existe e o passo é pulado (optional).
    name: 'denuncias_de_mensagens',
    optional: true,
    sql: `DELETE FROM message_reports
          WHERE reporter_id = $1
             OR message_id IN (
               SELECT id FROM messages
               WHERE sender_id = $1
                  OR mission_id IN (SELECT id FROM missions WHERE user_id = $1)
             )`
  },
  {
    // Migração 012 (convite por link): convites que a pessoa criou ou usou, e
    // os das missões dela. Antes da 012 a tabela não existe (optional).
    name: 'convites_de_missao',
    optional: true,
    sql: `DELETE FROM mission_invites
          WHERE created_by = $1
             OR used_by = $1
             OR mission_id IN (SELECT id FROM missions WHERE user_id = $1)`
  },
  {
    // Migração 011 (chat): bloqueios feitos pela pessoa e contra ela.
    name: 'bloqueios_do_chat',
    optional: true,
    sql: 'DELETE FROM user_blocks WHERE blocker_id = $1 OR blocked_id = $1'
  },
  {
    name: 'mensagens',
    sql: `DELETE FROM messages
          WHERE sender_id = $1
             OR mission_id IN (SELECT id FROM missions WHERE user_id = $1)`
  },
  {
    name: 'registro_de_avisos',
    sql: `DELETE FROM notification_log
          WHERE user_id = $1
             OR mission_id IN (SELECT id FROM missions WHERE user_id = $1)`
  },
  {
    name: 'inscricoes_de_push',
    sql: 'DELETE FROM push_subscriptions WHERE user_id = $1'
  },
  {
    // Migração 015: apoios dados pela pessoa e os recebidos nos posts dela.
    // Antes da 015 a tabela não existe (optional).
    name: 'apoios_dados_e_recebidos',
    optional: true,
    sql: `DELETE FROM community_post_supports
          WHERE user_id = $1
             OR post_id IN (SELECT id FROM community_posts WHERE user_id = $1)`
  },
  {
    name: 'denuncias_feitas_e_recebidas',
    sql: `DELETE FROM community_post_reports
          WHERE reporter_id = $1
             OR post_id IN (SELECT id FROM community_posts WHERE user_id = $1)`
  },
  {
    name: 'posts',
    sql: 'DELETE FROM community_posts WHERE user_id = $1'
  },
  {
    name: 'contagem_de_membros',
    sql: `UPDATE communities
          SET member_count = GREATEST(member_count - 1, 0)
          WHERE id IN (SELECT community_id FROM community_members WHERE user_id = $1)`
  },
  {
    name: 'membro_de_comunidades',
    sql: 'DELETE FROM community_members WHERE user_id = $1'
  },
  {
    name: 'participacao_em_missoes_de_comunidade',
    sql: 'DELETE FROM community_mission_participants WHERE user_id = $1'
  },
  {
    name: 'comunidades_criadas_sem_autor',
    sql: 'UPDATE communities SET created_by = NULL WHERE created_by = $1'
  },
  {
    name: 'missoes_de_comunidade_criadas_sem_autor',
    sql: 'UPDATE community_missions SET created_by = NULL WHERE created_by = $1'
  },
  {
    name: 'missoes',
    sql: 'DELETE FROM missions WHERE user_id = $1'
  },
  {
    name: 'conta',
    sql: 'DELETE FROM users WHERE id = $1'
  }
];

// Passo optional: tabela (ou coluna, com missingCodes ['42703']) de uma
// migração que pode ainda não ter sido aplicada. Roda dentro de um SAVEPOINT;
// se a tabela não existe (42P01) ou a coluna listada não existe, desfaz só
// esse passo e segue. Qualquer outro erro derruba a exclusão inteira, como antes.
async function runStep(client, step, userId) {
  if (!step.optional) return client.query(step.sql, [userId]);
  await client.query('SAVEPOINT passo_opcional');
  try {
    const result = await client.query(step.sql, [userId]);
    await client.query('RELEASE SAVEPOINT passo_opcional');
    return result;
  } catch (err) {
    const missing = ['42P01', ...(step.missingCodes || [])];
    if (err && missing.includes(err.code)) {
      await client.query('ROLLBACK TO SAVEPOINT passo_opcional');
      return { rowCount: 0 };
    }
    throw err;
  }
}

async function deleteAccountData(client, userId) {
  const counts = {};
  for (const step of ACCOUNT_DELETION_STEPS) {
    const result = await runStep(client, step, userId);
    counts[step.name] = result && typeof result.rowCount === 'number' ? result.rowCount : 0;
  }
  return counts;
}

module.exports = { ACCOUNT_DELETION_STEPS, TRANSFERRED_MISSION_TITLE, deleteAccountData };

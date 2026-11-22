// ============================================
// NEXUS — Excluir a conta (dados da pessoa)
//
// Base: legal/privacidade-beta-1.md, seção 9 (privado do conselho). Apaga
// conta, e-mail, senha, confirmação 18+, lembrete, contratos e missões,
// check-ins e notas, mensagens, contato da Porta Aberta, inscrições de push,
// registro de avisos, posts e denúncias feitas pela pessoa.
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
// - Missão de que a pessoa é dona, sem parceiro: sai inteira.
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
    // Antes da troca de dono: depois dela, a missão passada ao parceiro já
    // não é "da pessoa" e o par dela ficaria para trás.
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
    // Duo, dono sai: a missão passa ao parceiro, sem o contrato de quem saiu.
    // Tem de vir ANTES de apagar check-ins, mensagens, avisos e missões: os
    // passos seguintes só pegam o que ainda é da pessoa.
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
            AND partner_id <> $1`
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

async function deleteAccountData(client, userId) {
  const counts = {};
  for (const step of ACCOUNT_DELETION_STEPS) {
    const result = await client.query(step.sql, [userId]);
    counts[step.name] = result && typeof result.rowCount === 'number' ? result.rowCount : 0;
  }
  return counts;
}

module.exports = { ACCOUNT_DELETION_STEPS, TRANSFERRED_MISSION_TITLE, deleteAccountData };

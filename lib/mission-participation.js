// ============================================
// NEXUS — De quem é a missão, para a comunidade (achado do Argos no PR 44)
//
// A pessoa participa de uma missão se é a dona (user_id) ou a parceira do
// Duo de verdade, na MESMA missão (partner_id). No Rival (mode = 'rival',
// convite do PR 38) e num par por mission_matches, cada um tem a sua missão
// e o partner_id aponta para o outro: aí a missão do outro NÃO é da pessoa
// (não conta para o mérito, não libera post nem rolagem).
//
// Par por mission_matches: só exclui quando o OUTRO lado do par é uma
// missão da própria pessoa (o par cruzado). Não olha o status: no código, o
// par só vira 'ended' em endMatchInTransaction, que zera o partner_id; ao
// concluir, o par continua 'active' com o partner_id cruzado. Assim:
// - par concluído (cruzado): não conta em dobro;
// - par antigo encerrado com OUTRA pessoa, e depois um Duo por convite na
//   mesma missão: o parceiro novo conta (2.ª leitura do Argos no PR 44).
// Caso raro aceito: par antigo encerrado e Duo novo com a MESMA pessoa na
// mesma missão: o parceiro não conta essa (fica a menos, nunca em dobro).
// Uma regra só, usada pelo mérito, pelo post e pela rolagem.
// ============================================

// Condição SQL. who: um parâmetro ($1) ou uma coluna fixa (cm.user_id);
// alias: o apelido da tabela missions na consulta. Nunca vem do pedido.
function ownOrDuoMissionSql(who, alias = 'm') {
  if (!/^(\$\d+|[a-z_]+\.[a-z_]+)$/.test(who)) throw new Error('referência inválida');
  if (!/^[a-z_]+$/.test(alias)) throw new Error('apelido inválido');
  return `(${alias}.user_id = ${who}
            OR (${alias}.partner_id = ${who}
                AND COALESCE(${alias}.mode, '') <> 'rival'
                AND NOT EXISTS (
                  SELECT 1 FROM mission_matches mx
                  JOIN missions mo
                    ON mo.id = CASE WHEN mx.mission_a_id = ${alias}.id THEN mx.mission_b_id ELSE mx.mission_a_id END
                  WHERE (mx.mission_a_id = ${alias}.id OR mx.mission_b_id = ${alias}.id)
                    AND mo.user_id = ${who}
                )))`;
}

module.exports = { ownOrDuoMissionSql };

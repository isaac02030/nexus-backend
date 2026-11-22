// Ajuda dos testes: o middleware de login (middleware/auth.js) confere a
// cada pedido que a conta existe. Nos testes com banco simulado, esta
// função responde essa consulta ("a conta existe", ou não, para os ids de
// `missing`) e passa o resto para o simulador do próprio teste, que não
// vê a consulta do login (as contagens de consultas dele não mudam).
const AUTH_SQL = /^\s*SELECT 1 FROM users WHERE id = \$1\s*$/;

function withAuthDb(handler, { missing = () => false } = {}) {
  return function query(sql, params) {
    if (AUTH_SQL.test(String(sql))) {
      const id = Number(params && params[0]);
      return Promise.resolve({ rows: missing(id) ? [] : [{ '?column?': 1 }] });
    }
    return handler.call(this, sql, params);
  };
}

module.exports = { withAuthDb, AUTH_SQL };

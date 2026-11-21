// ============================================
// NEXUS — Desligamento limpo
//
// Ao receber SIGTERM/SIGINT (o provedor manda SIGTERM ao reiniciar):
// 1. para os lembretes (não começam consultas novas);
// 2. para de aceitar pedidos e espera os que estão no meio terminarem;
// 3. fecha o Pool do banco;
// 4. sai com 0. Se algo travar, sai com 1 depois de timeoutMs.
// ============================================

function createShutdown({
  server,
  closeDb,
  stopTimers = () => {},
  exit = code => process.exit(code),
  log = console,
  timeoutMs = 10000
}) {
  let started = false;

  return function shutdown(signal) {
    if (started) return;
    started = true;
    log.log(`Recebi ${signal}. Desligando com calma: termino os pedidos em curso e fecho o banco.`);

    const timer = setTimeout(() => {
      log.error('O desligamento passou do tempo. Saindo assim mesmo.');
      exit(1);
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    try {
      stopTimers();
    } catch (err) {
      log.error('Não consegui parar os lembretes:', err && err.code ? err.code : 'erro');
    }

    server.close(async closeErr => {
      let code = closeErr ? 1 : 0;
      try {
        await closeDb();
      } catch (err) {
        log.error('Não consegui fechar a conexão com o banco:', err && err.code ? err.code : 'erro');
        code = 1;
      }
      clearTimeout(timer);
      exit(code);
    });
  };
}

module.exports = { createShutdown };

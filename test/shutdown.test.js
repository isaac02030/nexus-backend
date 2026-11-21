const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createShutdown } = require('../lib/shutdown');

const quietLog = { log() {}, error() {} };

function fakeServer(steps, { closeErr = null, hang = false } = {}) {
  return {
    close(cb) {
      steps.push('server.close');
      if (!hang) setImmediate(() => cb(closeErr));
    }
  };
}

test('ordem: para lembretes, fecha o servidor, fecha o banco, sai com 0', async () => {
  const steps = [];
  const exited = new Promise(resolve => {
    const shutdown = createShutdown({
      server: fakeServer(steps),
      closeDb: async () => { steps.push('closeDb'); },
      stopTimers: () => steps.push('stopTimers'),
      exit: code => resolve(code),
      log: quietLog
    });
    shutdown('SIGTERM');
    shutdown('SIGTERM'); // segundo sinal não repete nada
  });
  assert.equal(await exited, 0);
  assert.deepEqual(steps, ['stopTimers', 'server.close', 'closeDb']);
});

test('se o banco não fecha, sai com 1', async () => {
  const code = await new Promise(resolve => {
    createShutdown({
      server: fakeServer([]),
      closeDb: async () => { const e = new Error('x'); e.code = 'ECONNRESET'; throw e; },
      exit: resolve,
      log: quietLog
    })('SIGINT');
  });
  assert.equal(code, 1);
});

test('se algo trava, sai com 1 depois do tempo limite', async () => {
  // O timer do desligamento usa unref (não segura o processo); este segura o teste.
  const keepAlive = setInterval(() => {}, 1000);
  const code = await new Promise(resolve => {
    createShutdown({
      server: fakeServer([], { hang: true }),
      closeDb: async () => {},
      exit: resolve,
      log: quietLog,
      timeoutMs: 20
    })('SIGTERM');
  });
  clearInterval(keepAlive);
  assert.equal(code, 1);
});

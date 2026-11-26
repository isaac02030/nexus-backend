// ============================================
// NEXUS — Pontos do Rival (beta)
//
// Decisão de 26/11 (plano do Vitrúvio, PR 1): cada dia cumprido vale 10
// pontos. O dia difícil é dia cumprido (completed = true), então vale 10
// também. Dia livre e falta não pontuam. Sem bônus no beta (fica para
// depois, com teto). Os check-ins chegam já filtrados pelo início do par
// (no SQL, com o relógio do banco); aqui só se conta.
// ============================================

const POINTS_PER_DAY = 10;

// checkins: [{ day_number, completed }]; isMissionDay(dia) diz se o dia é da
// missão (dia livre = false). Um ponto por dia, mesmo com linha repetida.
function rivalPoints(checkins, isMissionDay = () => true) {
  const days = new Set();
  for (const row of checkins || []) {
    if (!row || row.completed !== true) continue;
    const day = Number(row.day_number);
    if (!Number.isInteger(day) || day < 1) continue;
    if (!isMissionDay(day)) continue;
    days.add(day);
  }
  return days.size * POINTS_PER_DAY;
}

module.exports = { POINTS_PER_DAY, rivalPoints };

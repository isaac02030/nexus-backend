// Estado de recuperação da sequência.
// missed_days continua contando hoje quando o dia ainda está aberto.
// missed_days_before_today ignora hoje: só os dias da missão anteriores,
// em sequência, sem check-in concluído. Nunca fica negativo.

function missedDaysBeforeToday(doneDays, todayDay) {
  const today = Number(todayDay);
  if (!Number.isFinite(today) || today <= 1) return 0;

  let missed = 0;
  for (let day = today - 1; day >= 1; day -= 1) {
    if (doneDays.has(day)) break;
    missed += 1;
  }

  return missed;
}

function calculateRecoveryState(doneDays, todayDay) {
  const missedYesterday = todayDay > 1 && !doneDays.has(todayDay - 1);
  let missedDays = 0;

  for (let day = todayDay; day >= 1; day--) {
    if (doneDays.has(day)) break;
    missedDays++;
  }

  return {
    missed_yesterday: missedYesterday,
    missed_days: missedDays,
    missed_days_before_today: missedDaysBeforeToday(doneDays, todayDay),
    recovery_needed: missedYesterday && !doneDays.has(todayDay)
  };
}

module.exports = {
  missedDaysBeforeToday,
  calculateRecoveryState
};

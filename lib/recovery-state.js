// Estado de recuperação da sequência.
// missed_days continua contando hoje quando o dia ainda está aberto.
// missed_days_before_today ignora hoje: só os dias da missão anteriores,
// em sequência, sem check-in concluído. Nunca fica negativo.
//
// Dias livres (fora dos dias da missão escolhidos no contrato) não são
// falta: são pulados, sem contar e sem interromper a contagem.
// missed_yesterday olha o dia da missão anterior a hoje (que pode ser
// anteontem, se ontem foi dia livre). Num dia livre não há recuperação
// pedida, porque não há check-in.
// Sem isMissionDay, todo dia é da missão (como antes).

function asChecker(isMissionDay) {
  return typeof isMissionDay === 'function' ? isMissionDay : () => true;
}

function countMissedFrom(doneDays, fromDay, check) {
  let missed = 0;
  for (let day = fromDay; day >= 1; day -= 1) {
    if (!check(day)) continue;
    if (doneDays.has(day)) break;
    missed += 1;
  }
  return missed;
}

function missedDaysBeforeToday(doneDays, todayDay, isMissionDay) {
  const today = Number(todayDay);
  if (!Number.isFinite(today) || today <= 1) return 0;
  return countMissedFrom(doneDays, today - 1, asChecker(isMissionDay));
}

function calculateRecoveryState(doneDays, todayDay, isMissionDay) {
  const check = asChecker(isMissionDay);
  let previousDay = 0;
  for (let day = todayDay - 1; day >= 1; day -= 1) {
    if (check(day)) {
      previousDay = day;
      break;
    }
  }
  const missedYesterday = previousDay >= 1 && !doneDays.has(previousDay);
  const todayIsMissionDay = todayDay >= 1 && check(todayDay);

  return {
    missed_yesterday: missedYesterday,
    missed_days: countMissedFrom(doneDays, todayDay, check),
    missed_days_before_today: missedDaysBeforeToday(doneDays, todayDay, check),
    recovery_needed: todayIsMissionDay && missedYesterday && !doneDays.has(todayDay)
  };
}

module.exports = {
  missedDaysBeforeToday,
  calculateRecoveryState
};

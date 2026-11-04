/** Compare observed, settled point balances. A pending balance is not proof of success. */
export function checkBalanceChange(before, after, expectedDebit) {
  if (
    !before ||
    !after ||
    !Number.isSafeInteger(before.confirmedBalance) ||
    !Number.isSafeInteger(after.confirmedBalance) ||
    !Number.isSafeInteger(expectedDebit) ||
    expectedDebit < 0
  ) {
    return { status: 'failed', text: 'The server did not return valid point amounts.' };
  }
  if (
    [before, after].some(
      (balance) => balance.stale !== false || balance.pendingEarn !== 0 || balance.pendingRedemption !== 0,
    )
  ) {
    return { status: 'waiting', text: 'Points are still settling. Refresh the status before judging this check.' };
  }
  const expected = before.confirmedBalance - expectedDebit;
  return after.confirmedBalance === expected
    ? {
        status: 'passed',
        text: `${before.confirmedBalance} to ${after.confirmedBalance} points. ${expectedDebit === 0 ? 'No extra points were deducted.' : `Exactly ${expectedDebit} points were deducted.`}`,
      }
    : {
        status: 'failed',
        text: `Expected ${expected} points, but received ${after.confirmedBalance}. Starting balance: ${before.confirmedBalance}.`,
      };
}

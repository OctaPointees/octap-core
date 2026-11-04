// This page holds only the customer's browser session; merchant credentials stay on the server.
import { createOctapAuth } from '@octap/browser-sdk';
import { checkBalanceChange } from './checks.mjs';

const element = (id) => document.getElementById(id);
const output = element('output');
const claimButton = element('claim');
const redeemButton = element('redeem');
const refreshButton = element('refresh');
const signOutButton = element('sign-out');
const stepIds = ['signin', 'reserved', 'signed', 'finalized', 'claim-balance', 'redeemed', 'redeem-balance'];
const defaults = new Map(stepIds.map((id) => [id, element(`check-${id}`).querySelector('p').textContent]));
let currentClaim;
let beforeClaim;
let beforeRedeem;
let freshClaim = false;
let claimBalancePassed = false;
let redeemBalancePassed = false;
let busy = false;
let activeStep;
let sessionRevision = 0;

function step(id, status, text) {
  const row = element(`check-${id}`);
  row.dataset.state = status;
  row.querySelector('.badge').textContent = {
    passed: 'Passed',
    failed: 'Failed',
    waiting: 'Waiting',
    skipped: 'Not tested',
  }[status];
  row.querySelector('p').textContent = text;
}
function notice(text, status = 'waiting') {
  element('notice').textContent = text;
  element('notice').dataset.state = status;
}
function controls() {
  claimButton.disabled = busy || !auth.currentUser || Boolean(currentClaim);
  redeemButton.disabled = busy || !auth.currentUser || currentClaim?.status !== 'AVAILABLE';
  refreshButton.disabled = busy || !auth.currentUser || !currentClaim;
  signOutButton.disabled = busy || !auth.currentUser;
}
function showError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (activeStep) step(activeStep, 'failed', message);
  notice(`${message} Nothing will be retried automatically. Use Refresh status if a claim was created.`, 'failed');
  output.textContent = message;
}
async function askBackend(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { authorization: `Bearer ${await auth.getIdToken()}`, 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${path} (HTTP ${response.status}): ${data.message ?? 'Request failed'}`);
  return data;
}
function balanceCard(id, balance) {
  element(id).textContent = String(balance.confirmedBalance);
}
async function readClaimState() {
  currentClaim = await askBackend('/api/claim/state', { ownershipId: currentClaim.voucherOwnershipId });
  const balance = await askBackend('/api/balance');
  if (currentClaim.status === 'AVAILABLE' || currentClaim.status === 'REDEEMED') {
    const validConfirmation =
      !freshClaim ||
      (Number.isSafeInteger(currentClaim.pointsCost) &&
        currentClaim.pointsCost > 0 &&
        currentClaim.pointsDeducted === currentClaim.pointsCost);
    step(
      'finalized',
      validConfirmation ? 'passed' : 'failed',
      validConfirmation
        ? `The server confirms this voucher is ${currentClaim.status}.`
        : 'The voucher status and reported claim cost do not agree.',
    );
    if (freshClaim && !beforeRedeem) {
      balanceCard('balance-claimed', balance);
      const check = checkBalanceChange(beforeClaim, balance, currentClaim.pointsCost);
      step('claim-balance', check.status, check.text);
      claimBalancePassed = check.status === 'passed' && validConfirmation;
    } else if (!freshClaim) {
      step(
        'claim-balance',
        'skipped',
        'This voucher was claimed earlier. Its original point deduction was not tested in this run.',
      );
    }
  } else if (currentClaim.status === 'RESERVED') {
    step('finalized', 'waiting', 'The claim is still RESERVED. Wait, then click Refresh status.');
  } else {
    step('finalized', 'failed', `The voucher is ${currentClaim.status}; it cannot be used.`);
  }
  if (currentClaim.status === 'REDEEMED' && beforeRedeem) {
    step('redeemed', 'passed', 'The server confirms the voucher has been used.');
    balanceCard('balance-redeemed', balance);
    const check = checkBalanceChange(beforeRedeem, balance, 0);
    step('redeem-balance', check.status, check.text);
    redeemBalancePassed = check.status === 'passed';
  }
  output.textContent = JSON.stringify({ claim: currentClaim, balance }, null, 2);
  return balance;
}

const configResponse = await fetch('/config');
if (!configResponse.ok) throw new Error('Could not load the example configuration.');
const config = await configResponse.json();
element('voucher-name').textContent = `${config.voucher.title} - ${config.voucher.pointsCost} points to claim`;
const auth = createOctapAuth(config);
auth.onAuthStateChanged((user) => {
  const revision = ++sessionRevision;
  currentClaim = beforeClaim = beforeRedeem = undefined;
  freshClaim = false;
  claimBalancePassed = redeemBalancePassed = false;
  activeStep = undefined;
  for (const id of stepIds) step(id, 'skipped', defaults.get(id));
  for (const id of ['balance-before', 'balance-claimed', 'balance-redeemed']) element(id).textContent = '--';
  element('session').textContent = user
    ? 'Signed in. Your merchant key stays on the backend.'
    : 'Sign in with Google to start.';
  controls();
  if (!user) {
    notice('Sign in to begin. No points move until you click Claim voucher.');
    output.textContent = 'No result yet.';
    return;
  }
  step('signin', 'passed', 'Your customer session is ready.');
  notice('Ready. Click Claim voucher to exchange points for this reward.');
  void askBackend('/api/balance')
    .then((balance) => {
      if (revision !== sessionRevision) return;
      balanceCard('balance-before', balance);
    })
    .catch((error) => {
      if (revision === sessionRevision) showError(error);
    });
});
auth.renderGoogleButton(element('sign-in'), { onError: showError }).catch(showError);

claimButton.addEventListener('click', async () => {
  busy = true;
  controls();
  try {
    beforeClaim = await askBackend('/api/balance');
    balanceCard('balance-before', beforeClaim);
    activeStep = 'reserved';
    step('reserved', 'waiting', 'Asking the merchant backend to reserve this voucher...');
    notice('Claim in progress. Your browser will sign the sponsored transaction.');
    currentClaim = await askBackend('/api/claim');
    if (currentClaim.status === 'RESERVED') {
      if (!currentClaim.digest || !currentClaim.transactionBytes || currentClaim.pointsDeducted !== 0) {
        throw new Error('The reservation did not include valid signing details. No signature was sent.');
      }
      freshClaim = true;
      step('reserved', 'passed', 'RESERVED: signing details received. No confirmed points have been charged yet.');
      activeStep = 'signed';
      step('signed', 'waiting', 'Signing with your customer session in this browser...');
      const signature = await auth.signTransaction(currentClaim.transactionBytes);
      step('signed', 'passed', 'Your customer session signed the transaction locally.');
      activeStep = 'finalized';
      step('finalized', 'waiting', 'Waiting for Core to confirm the signed claim...');
      await askBackend('/api/claim/finalize', { ownershipId: currentClaim.voucherOwnershipId, signature });
    } else {
      step('reserved', 'skipped', 'Recovered a voucher you already own; no new reservation was made.');
      step('signed', 'skipped', 'No new signing was needed. Use a fresh voucher to test this step.');
    }
    await readClaimState();
    if (currentClaim.status === 'AVAILABLE') {
      notice(
        freshClaim && !claimBalancePassed
          ? 'The voucher is ready, but the point deduction check has not passed. Review the checks below.'
          : 'The voucher is ready. Click Redeem voucher to use it without another point charge.',
        freshClaim && !claimBalancePassed ? 'waiting' : 'passed',
      );
    } else notice(`Voucher status: ${currentClaim.status}. Check the steps below.`);
  } catch (error) {
    showError(error);
  } finally {
    activeStep = undefined;
    busy = false;
    controls();
  }
});

redeemButton.addEventListener('click', async () => {
  busy = true;
  controls();
  try {
    beforeRedeem = await askBackend('/api/balance');
    activeStep = 'redeemed';
    step('redeemed', 'waiting', 'Using the voucher at the merchant...');
    const result = await askBackend('/api/claim/redeem', { ownershipId: currentClaim.voucherOwnershipId });
    if (result.status !== 'REDEEMED' || result.voucherOwnershipId !== currentClaim.voucherOwnershipId) {
      throw new Error('The redemption response did not confirm this voucher was used.');
    }
    await readClaimState();
    if (currentClaim.status !== 'REDEEMED')
      throw new Error('The saved voucher state has not confirmed redemption. Refresh its status.');
    notice(
      redeemBalancePassed
        ? 'Passed: the voucher is used and your points stayed unchanged.'
        : 'The voucher was used, but its balance check has not passed. Review the checks below.',
      redeemBalancePassed ? 'passed' : 'waiting',
    );
  } catch (error) {
    showError(error);
  } finally {
    activeStep = undefined;
    busy = false;
    controls();
  }
});
refreshButton.addEventListener('click', async () => {
  busy = true;
  controls();
  try {
    await readClaimState();
    notice(`Status refreshed: ${currentClaim.status}. No mutation was retried.`);
  } catch (error) {
    showError(error);
  } finally {
    busy = false;
    controls();
  }
});
signOutButton.addEventListener('click', () => auth.signOut().catch(showError));

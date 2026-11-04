// Bundled by server.mjs. Holds no merchant credential: only public configuration reaches this page.
import { createOctapAuth, OctapAuthError } from '@octap/browser-sdk';

const output = document.getElementById('output');
const claimButton = document.getElementById('claim');
const signOutButton = document.getElementById('sign-out');
const show = (label, value) => {
  output.textContent = `${label}\n${JSON.stringify(value, null, 2)}`;
};
const showError = (error) =>
  show(
    'Error',
    error instanceof OctapAuthError
      ? { code: error.code, status: error.status, message: error.message }
      : String(error),
  );

const config = await (await fetch('/config')).json();
const auth = createOctapAuth(config);

auth.onAuthStateChanged((user) => {
  claimButton.disabled = !user;
  signOutButton.disabled = !user;
  show('Current user', user);
});

auth.renderGoogleButton(document.getElementById('sign-in'), { onError: showError }).catch(showError);

/** The merchant backend's half: it verifies the customer, then claims with its API key. */
async function askBackend(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { authorization: `Bearer ${await auth.getIdToken()}`, 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message ?? `Backend answered ${response.status}`);
  return data;
}

claimButton.addEventListener('click', async () => {
  claimButton.disabled = true;
  try {
    const claim = await askBackend('/api/claim');
    show('Claim from the backend (not owned while RESERVED)', claim);
    if (claim.status === 'RESERVED') {
      const finalized = await auth.signAndFinalize(claim);
      show('Finalized', finalized);
    }
    show(
      'Claim state from the backend',
      await askBackend('/api/claim/state', { ownershipId: claim.voucherOwnershipId }),
    );
  } catch (error) {
    showError(error);
  } finally {
    claimButton.disabled = !auth.currentUser;
  }
});

signOutButton.addEventListener('click', () => {
  auth.signOut().catch(showError);
});

import type { PendingAuthorizationView } from '#domain/mcp-auth/mcp-oauth.service.js';

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/** JSON inside a `<script>` must not be able to close the tag. */
const scriptJson = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');

const STYLE = `
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: Canvas; color: CanvasText; }
  main { width: min(440px, calc(100vw - 32px)); padding: 32px; border: 1px solid #8884; border-radius: 12px; }
  h1 { font-size: 20px; margin: 0 0 12px; }
  p { line-height: 1.5; margin: 0 0 16px; }
  .muted { opacity: 0.75; font-size: 14px; }
  button { display: block; width: 100%; padding: 12px; margin: 8px 0; border-radius: 8px;
    border: 1px solid #8886; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
  button:hover { border-color: #b4006e; }
  [role=alert] { color: #c62828; }
`;

/** Page shown when the authorization request itself is invalid: never redirect to an unverified URI. */
export function renderAuthorizationError(message: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>OctaP sign-in</title>
<style>${STYLE}</style></head><body><main><h1>Cannot sign in</h1>
<p role="alert">${escapeHtml(message)}</p><p class="muted">Start the connection again from your MCP client.</p>
</main></body></html>`;
}

/**
 * The consent page: Google sign-in (Google Identity Services, with the request id as nonce), then an
 * organization picker when the user belongs to several. Each step posts JSON back to Core.
 */
export function renderAuthorizationPage(view: PendingAuthorizationView) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>OctaP sign-in</title>
<style>${STYLE}</style>
<script src="https://accounts.google.com/gsi/client" async></script></head>
<body><main>
<h1>Connect ${escapeHtml(view.clientName)} to OctaP</h1>
<p>It will be able to <strong>read</strong> data of one organization you belong to, as you, for one hour.
It cannot change anything.</p>
<p class="muted">After sign-in you return to <strong>${escapeHtml(view.redirectHost)}</strong>.
Only continue if you started this from your own MCP client.</p>
<div id="step"><div id="google"></div></div>
<p id="error" role="alert"></p>
</main>
<script id="config" type="application/json">${scriptJson({ requestId: view.requestId, googleClientId: view.googleClientId })}</script>
<script>
(() => {
  const config = JSON.parse(document.getElementById('config').textContent);
  const step = document.getElementById('step');
  const error = document.getElementById('error');
  const post = async (path, body) => {
    const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || 'Sign-in failed. Start again from your MCP client.');
    return data;
  };
  const next = (result) => {
    if (result.redirectTo) { step.textContent = 'Signed in. Returning to your MCP client…'; window.location.assign(result.redirectTo); return; }
    step.replaceChildren(Object.assign(document.createElement('p'), { textContent: 'Choose the organization to connect:' }));
    for (const organization of result.organizations) {
      const button = document.createElement('button');
      button.textContent = organization.name + (organization.persona === 'BUSINESS_OWNER' ? ' (Owner)' : ' (Developer)');
      button.addEventListener('click', () => {
        error.textContent = '';
        post('/oauth/authorize/organization', { requestId: config.requestId, organizationId: organization.organizationId })
          .then(next, (cause) => { error.textContent = cause.message; });
      });
      step.append(button);
    }
  };
  const start = () => {
    if (!window.google?.accounts?.id) { setTimeout(start, 100); return; }
    google.accounts.id.initialize({
      client_id: config.googleClientId,
      nonce: config.requestId,
      auto_select: false,
      callback: ({ credential }) => {
        error.textContent = '';
        post('/oauth/authorize/google', { requestId: config.requestId, credential })
          .then(next, (cause) => { error.textContent = cause.message; });
      },
    });
    google.accounts.id.renderButton(document.getElementById('google'), { theme: 'outline', size: 'large', text: 'signin_with' });
  };
  start();
})();
</script></body></html>`;
}

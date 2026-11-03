import { generateKeyPairSync, sign } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GoogleIdentityClient } from '#infra/clients/google/google-identity.client.js';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const audience = 'portal.apps.googleusercontent.com';
function token(overrides: Record<string, unknown> = {}, privateKey = keys.privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'fixture' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      iss: 'https://accounts.google.com',
      aud: audience,
      sub: 'google-subject',
      email: 'Person@Example.com',
      email_verified: true,
      name: 'Person',
      picture: 'https://example.com/avatar',
      iat: now,
      exp: now + 3600,
      ...overrides,
    }),
  ).toString('base64url');
  const data = `${header}.${payload}`;
  return `${data}.${sign('RSA-SHA256', Buffer.from(data), privateKey).toString('base64url')}`;
}
describe('GoogleIdentityClient', () => {
  beforeEach(() => {
    vi.stubEnv('CONSOLE_GOOGLE_CLIENT_ID', audience);
    vi.spyOn(OAuth2Client.prototype, 'getFederatedSignonCertsAsync').mockResolvedValue({
      certs: { fixture: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() },
      format: 'PEM' as Awaited<ReturnType<OAuth2Client['getFederatedSignonCertsAsync']>>['format'],
    });
  });
  it('uses Google cryptographic verification and normalizes the verified account', async () => {
    expect(await new GoogleIdentityClient().verify(token({ azp: audience }))).toMatchObject({
      subject: 'google-subject',
      email: 'person@example.com',
      fullName: 'Person',
      avatarUrl: 'https://example.com/avatar',
    });
    expect(await new GoogleIdentityClient().verify(token({ name: undefined, picture: undefined }))).toMatchObject({
      fullName: 'Person@Example.com',
      avatarUrl: null,
    });
  });
  it.each([
    { aud: 'another-client' },
    { iss: 'https://attacker.example' },
    { exp: 1 },
    { email_verified: false },
    { sub: '' },
    { email: '' },
    { azp: 'another-client' },
  ])('rejects invalid token claims %j', async (claims) => {
    await expect(new GoogleIdentityClient().verify(token(claims))).rejects.toMatchObject({ status: 401 });
  });
  it('rejects invalid signatures and malformed credentials', async () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const client = new GoogleIdentityClient();
    for (const credential of [token({}, other.privateKey), '', 'bad-token', 'x'.repeat(16385)]) {
      await expect(client.verify(credential)).rejects.toMatchObject({ status: 401 });
    }
  });
  it('fails closed when no web client is configured', async () => {
    vi.stubEnv('CONSOLE_GOOGLE_CLIENT_ID', '');
    await expect(new GoogleIdentityClient().verify(token())).rejects.toMatchObject({ status: 503 });
  });
  it('reports certificate transport failures as temporary unavailability', async () => {
    vi.mocked(OAuth2Client.prototype.getFederatedSignonCertsAsync).mockRejectedValueOnce(
      new Error('Failed to retrieve verification certificates: connection reset'),
    );
    await expect(new GoogleIdentityClient().verify(token())).rejects.toMatchObject({ status: 503 });
  });
});

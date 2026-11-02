import { createDecipheriv } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { OrganizationIdentityCipher } from '#infra/db/organization-identity.cipher.js';

describe('OrganizationIdentityCipher', () => {
  it('encrypts with a fresh IV and binds the ciphertext to its organization', () => {
    const key = Buffer.alloc(32, 7);
    vi.stubEnv('ORGANIZATION_IDENTITY_ENCRYPTION_KEY', key.toString('base64'));
    const cipher = new OrganizationIdentityCipher();
    const encrypted = cipher.encrypt('000000000001', 'org-1');
    expect(cipher.encrypt('000000000001', 'org-1')).not.toBe(encrypted);
    const [version, iv, tag, value] = encrypted.split('.');
    expect(version).toBe('v1');
    const decode = (orgId: string) => {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
      decipher.setAAD(Buffer.from(orgId));
      decipher.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(value, 'base64')), decipher.final()]).toString();
    };
    expect(decode('org-1')).toBe('000000000001');
    expect(() => decode('org-2')).toThrow();
  });
  it.each(['', 'bad', Buffer.alloc(16).toString('base64')])('rejects missing or invalid server key %s', (value) => {
    vi.stubEnv('ORGANIZATION_IDENTITY_ENCRYPTION_KEY', value);
    expect(() => new OrganizationIdentityCipher().encrypt('000000000001', 'org')).toThrow(
      'CCCD storage is not configured',
    );
  });
});

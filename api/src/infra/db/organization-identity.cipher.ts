import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createCipheriv, randomBytes } from 'node:crypto';

@Injectable()
export class OrganizationIdentityCipher {
  encrypt(nationalId: string, organizationId: string): string {
    const configured = process.env.ORGANIZATION_IDENTITY_ENCRYPTION_KEY ?? '';
    if (!/^[A-Za-z0-9+/]{43}=$/.test(configured) || Buffer.from(configured, 'base64').length !== 32) {
      throw new ServiceUnavailableException('CCCD storage is not configured');
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(configured, 'base64'), iv);
    cipher.setAAD(Buffer.from(organizationId));
    const encrypted = Buffer.concat([cipher.update(nationalId, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join(
      '.',
    );
  }
}

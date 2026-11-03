import { ConflictException, Injectable } from '@nestjs/common';
import type { ConsoleIdentity } from '@octap/contracts';
import { GoogleIdentityClient } from '#infra/clients/google/google-identity.client.js';
import {
  ConsoleUsersRepository,
  GoogleAccountLinkRequiredError,
} from '#infra/db/repositories/console-users.repository.js';

@Injectable()
export class ConsoleIdentityService {
  constructor(
    private readonly google: GoogleIdentityClient,
    private readonly users: ConsoleUsersRepository,
  ) {}

  async authenticate(idToken: string): Promise<ConsoleIdentity> {
    const identity = await this.google.verify(idToken);
    try {
      const user = await this.users.resolveGoogleUser(identity);
      return {
        user: {
          id: user.id,
          email: identity.email,
          fullName: user.fullName,
          avatarUrl: user.avatarUrl,
          systemRole: user.systemRole,
        },
        organizations: await this.users.memberships(user.id),
        expiresAt: new Date(identity.expiresAt * 1000).toISOString(),
      };
    } catch (error) {
      if (error instanceof GoogleAccountLinkRequiredError) {
        throw new ConflictException('An existing account requires administrator-assisted Google linking');
      }
      throw error;
    }
  }
}

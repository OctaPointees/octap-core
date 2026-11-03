import { Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { OAuth2Client } from 'google-auth-library';

export interface VerifiedGoogleIdentity {
  subject: string;
  email: string;
  fullName: string;
  avatarUrl: string | null;
  expiresAt: number;
}

/** Google library owns signature/JWKS caching, rotation, issuer, audience and expiry checks. */
@Injectable()
export class GoogleIdentityClient {
  private readonly client = new OAuth2Client();

  async verify(idToken: string): Promise<VerifiedGoogleIdentity> {
    const audience = process.env.CONSOLE_GOOGLE_CLIENT_ID?.trim();
    if (!audience) throw new ServiceUnavailableException('Console Google sign-in is not configured');
    if (typeof idToken !== 'string' || !idToken || idToken.length > 16384) {
      throw new UnauthorizedException('A valid Google ID token is required');
    }
    try {
      const ticket = await this.client.verifyIdToken({ idToken, audience });
      const claims = ticket.getPayload();
      if (
        !claims?.sub ||
        !claims.email ||
        claims.email_verified !== true ||
        !Number.isFinite(claims.exp) ||
        claims.exp * 1000 <= Date.now() ||
        (claims.azp !== undefined && claims.azp !== audience)
      ) {
        throw new Error('Missing or invalid identity claims');
      }
      return {
        subject: claims.sub,
        email: claims.email.toLowerCase(),
        fullName: claims.name || claims.email,
        avatarUrl: claims.picture ?? null,
        expiresAt: claims.exp,
      };
    } catch (error) {
      // google-auth-library prefixes certificate transport failures before rethrowing.
      if (error instanceof Error && error.message.startsWith('Failed to retrieve verification certificates:'))
        throw new ServiceUnavailableException('Google sign-in is temporarily unavailable. Try again later.');
      throw new UnauthorizedException('Google identity could not be verified. Sign in again.');
    }
  }
}

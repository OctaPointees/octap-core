import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ConsoleIdentity } from '@octap/contracts';
import { ConsoleIdentityService } from '#domain/identity/console-identity.service.js';

export interface ConsoleRequest {
  headers: { authorization?: string };
  consoleIdentity: ConsoleIdentity;
}
export const PlatformAdminOnly = () => SetMetadata('console.platform-admin', true);

@Injectable()
export class ConsoleAccessGuard implements CanActivate {
  constructor(
    private readonly identity: ConsoleIdentityService,
    private readonly reflector: Reflector,
  ) {}
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<ConsoleRequest>();
    const credential = /^Bearer (.+)$/i.exec(request.headers.authorization ?? '')?.[1];
    if (!credential) throw new UnauthorizedException('Google ID token is required');
    request.consoleIdentity = await this.identity.authenticate(credential);
    if (
      this.reflector.getAllAndOverride<boolean>('console.platform-admin', [context.getHandler(), context.getClass()]) &&
      request.consoleIdentity.user.systemRole !== 'SYSTEM_ADMIN'
    )
      throw new ForbiddenException('System Admin access is required');
    return true;
  }
}

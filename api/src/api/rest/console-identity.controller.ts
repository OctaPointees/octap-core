import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Headers,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { Public } from '#infra/auth/public.decorator.js';
import { ConsoleIdentityService } from '#domain/identity/console-identity.service.js';

/** These routes verify Google credentials directly, never merchant API keys. */
@Public()
@Controller('v1/console')
export class ConsoleIdentityController {
  constructor(private readonly identity: ConsoleIdentityService) {}

  @Post('auth/google')
  @Header('Cache-Control', 'no-store')
  login(@Body() body: { idToken?: unknown }) {
    if (typeof body?.idToken !== 'string') throw new BadRequestException('idToken is required');
    return this.identity.authenticate(body.idToken);
  }

  @Get('me')
  @Header('Cache-Control', 'no-store')
  me(@Headers('authorization') authorization?: string) {
    if (!authorization?.startsWith('Bearer ')) throw new UnauthorizedException('Google ID token is required');
    return this.identity.authenticate(authorization.slice(7));
  }
}

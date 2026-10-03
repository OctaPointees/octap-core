import { Module } from '@nestjs/common';
import { IdentityService } from './identity.service.js';
import { ZkloginService } from './zklogin.service.js';
@Module({ providers: [IdentityService, ZkloginService], exports: [IdentityService, ZkloginService] })
export class IdentityModule {}

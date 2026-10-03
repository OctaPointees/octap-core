import { Module } from '@nestjs/common';
import { AdministrationService } from './administration.service.js';
@Module({ providers: [AdministrationService], exports: [AdministrationService] })
export class AdministrationModule {}

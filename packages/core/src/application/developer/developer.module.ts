import { Module } from '@nestjs/common';
import { DeveloperService } from './developer.service.js';
@Module({ providers: [DeveloperService], exports: [DeveloperService] })
export class DeveloperModule {}

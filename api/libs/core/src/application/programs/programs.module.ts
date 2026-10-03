import { Module } from '@nestjs/common';
import { ProgramsService } from './programs.service.js';
@Module({ providers: [ProgramsService], exports: [ProgramsService] })
export class ProgramsModule {}

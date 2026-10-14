import { Module } from '@nestjs/common';
import { PostgresModule } from '../../infra/db/postgres.module.js';
import { MembersService } from './members.service.js';

@Module({
  imports: [PostgresModule],
  providers: [MembersService],
  exports: [MembersService],
})
export class MembersModule {}

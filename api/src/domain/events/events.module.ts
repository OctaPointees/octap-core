import { Module } from '@nestjs/common';
import { PostgresModule } from '#infra/db/postgres.module.js';
import { ConsoleEventStreamService } from './console-event-stream.service.js';
import { OrganizationEventHub } from './organization-event-hub.js';

/** The console event stream (OCT-326). `EventRetentionWorker` is the worker process's, not this module's. */
@Module({
  imports: [PostgresModule],
  providers: [OrganizationEventHub, ConsoleEventStreamService],
  exports: [ConsoleEventStreamService],
})
export class EventsModule {}

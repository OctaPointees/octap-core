import { Module } from '@nestjs/common';
import { ApplicationModule } from '@octap/core';
/** Scaffold: Streamable HTTP transport, OAuth and tool registration are deferred. */
@Module({ imports: [ApplicationModule] })
export class McpModule {}

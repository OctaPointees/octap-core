import { Module } from '@nestjs/common';
import { ApplicationModule } from '@octap/core';
import { InfrastructureModule } from '@octap/infrastructure';
import { McpModule } from './mcp.module.js';
@Module({ imports: [ApplicationModule, InfrastructureModule, McpModule] })
export class AppModule {}

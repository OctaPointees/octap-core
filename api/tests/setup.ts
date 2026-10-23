import 'reflect-metadata';
import { Logger } from '@nestjs/common';

// Processors/workers log every failure path a test drives on purpose; that output is noise here.
// A test that asserts on logging spies on `Logger.prototype` directly.
Logger.overrideLogger(false);

import 'reflect-metadata';
import { Logger } from '@nestjs/common';

// Processors/workers log every failure path a test drives on purpose; that output is noise here.
// A test that asserts on logging spies on `Logger.prototype` directly.
Logger.overrideLogger(false);

// A developer's shell may point the worker signers at real AWS KMS keys; no test may reach them.
// Tests that exercise the KMS path stub these and a fake KMS endpoint themselves.
delete process.env.SUI_ISSUER_KMS_KEY_ID;
delete process.env.SUI_PROGRAM_ADMIN_KMS_KEY_ID;

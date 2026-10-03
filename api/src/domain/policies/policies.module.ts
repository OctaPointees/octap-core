import { Module } from '@nestjs/common';
import { PoliciesService } from './policies.service.js';
import { PolicyPreviewService } from './policy-preview.service.js';
@Module({ providers: [PoliciesService, PolicyPreviewService], exports: [PoliciesService, PolicyPreviewService] })
export class PoliciesModule {}

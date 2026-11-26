import { SetMetadata } from '@nestjs/common';
import type { LicenseFeature } from '@octap/contracts';

export const REQUIRES_FEATURE_KEY = 'license.requires-feature';

/**
 * The route needs the organization's license to include `feature` (OCT-329); `LicenseFeatureGuard`
 * answers 402 otherwise. Checked only once the caller is known to be the organization's (its API
 * key, or a console member), so an outsider still gets its 403 first.
 */
export const RequiresFeature = (feature: LicenseFeature) => SetMetadata(REQUIRES_FEATURE_KEY, feature);

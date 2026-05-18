// Managed profile publishing seam.
//
// The upload service is intentionally out-of-scope for the local profile work.
// This module defines the narrow client-side seam so `profile init` and
// `profile publish` can exercise the local generation/update path without
// depending on a live hosting service. The default implementation returns an
// empty result; replace it with the real HTTP client without changing the
// profile command grammar once managed upload exists.

import type { PlatformProfile } from './profile.js'
import { DEFAULT_PROFILE_URL } from './profile.js'
import type { ProfileMeta } from './profile-store.js'

// Publish infers managed-vs-DIY from URL ownership instead of persisting a
// second discriminator that can drift. Keep the service origin behind one
// constant so the Worker PR can change it without hunting call sites.
export const PROFILE_ORIGIN = 'https://profiles.ucp.dev'
export const MANAGED_PROFILE_URL_ORIGINS = [new URL(DEFAULT_PROFILE_URL).origin, PROFILE_ORIGIN]

export interface ProfileUploadInput {
  name: string
  body: PlatformProfile
  meta: ProfileMeta
}

export interface ProfileUploadResult {
  /** Public HTTPS URL where the profile is hosted. Absent until service exists. */
  profileUrl?: string
  /** Service-owned opaque id. */
  profileId?: string
  /** Hosted artifact ETag, if the service returns one. */
  etag?: string
  /** Publish timestamp. Defaults at call site when absent. */
  publishedAt?: string
}

export type UploadProfile = (input: ProfileUploadInput) => Promise<ProfileUploadResult>

export const noopUploadProfile: UploadProfile = async () => ({})

/**
 * Zod schema for the desktop app update manifest.
 *
 * One file per channel at downloads.nebulis.app/app/v1/<channel>/index.json,
 * signed by an Ed25519 detached signature at the same path + ".sig".
 * Produced by scripts/gen-app-manifest.mjs.
 */

import { z } from 'zod';

export const UPDATE_CHANNELS = ['stable', 'beta'] as const;
export type UpdateChannel = (typeof UPDATE_CHANNELS)[number];

const Artifact = z.object({
  url:    z.string().url(),
  sha256: z.string().length(64),
  bytes:  z.number().int().positive(),
});

const LatestRelease = z.object({
  version:           z.string().min(1),
  build:             z.number().int().nonnegative(),
  // Refuse an in-place update when the installed version is older than this
  // (forces a fresh download instead — guards against unsafe long jumps).
  minUpgradableFrom: z.string().min(1),
  mandatory:         z.boolean(),
  notesUrl:          z.string().url(),
  // Keyed by platform: 'win-x64' | 'mac-arm64' | 'mac-x64'. A channel may omit
  // platforms it has no build for.
  artifacts:         z.record(z.string(), Artifact),
});

export const AppUpdateIndex = z.object({
  schemaVersion: z.literal(1),
  channel:       z.enum(UPDATE_CHANNELS),
  generatedAt:   z.string(),
  latest:        LatestRelease,
});

export type AppUpdateIndex = z.infer<typeof AppUpdateIndex>;
export type Artifact = z.infer<typeof Artifact>;

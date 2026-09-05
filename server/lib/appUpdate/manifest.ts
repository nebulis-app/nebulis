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

/** Narrows a DB column / request body value to the union. See
 *  isPreferredCatalog in types/appSettings.ts for why this takes `unknown`. */
export function isUpdateChannel(value: unknown): value is UpdateChannel {
  return typeof value === 'string' && (UPDATE_CHANNELS as readonly string[]).includes(value);
}

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
  // Kill switch: when true the server suppresses this release entirely (no
  // banner, no staging, no apply). Lets a bad push be pulled back for clients
  // that have not updated yet without waiting on a follow-up build. Optional so
  // older manifests (and the generator's default output) stay valid.
  yanked:            z.boolean().optional(),
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

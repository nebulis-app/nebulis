#!/usr/bin/env node
/**
 * The Mac app's USB and drive-identity tests (NebulisDesktop XCTests), run from here so they are part of the same ladder as the web
 * suites: `npm run test:mac`, and automatically under `npm run verify -- --all` / `npm run test:all` on a Mac.
 *
 * It covers detection, pairing a drive with a telescope, refusing another telescope's drive, the swap of two same-named cards (real
 * mounted disk images), read-only cards, the Wi-Fi identity check, the watcher, and the database migration for drive ids.
 *
 * Builds into its own derived-data folder with ad-hoc signing, never the one Xcode uses: a build signed ad hoc and then built again by
 * Xcode in the same folder fails with "embedded binary is not signed with the same certificate".
 *
 * Skips (exit 0, and says so) anywhere that is not macOS with Xcode, or when the Mac project is not checked out next to this one.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT_DIR = path.resolve(ROOT, '..', 'nebulis-apple', 'NebulisDesktop');

/** Every XCTest class that exercises USB storage, drive identity or the telescope's route. Add a class here when you add one. */
export const CLASSES = [
  'LocalTransportTests', 'DriveDetectionTests', 'DriveMatchTests', 'TelescopeRouteTests', 'UsbPersistenceTests', 'UsbSetupFormTests',
  'UsbSyncEquivalenceTests', 'ServerTelescopeAdminTests', 'PlugInFlowTests', 'RealVolumeTests', 'DriveBindingTests',
  'DriveDatabaseMigrationTests', 'TwoRealSeestarsTests', 'WifiIdentityTests',
];

function skip(why) {
  console.log(`test:mac skipped: ${why}`);
  process.exit(0);
}

if (process.platform !== 'darwin') skip('needs macOS');
if (!fs.existsSync(path.join(PROJECT_DIR, 'NebulisDesktop.xcodeproj'))) skip(`no Mac project at ${path.relative(ROOT, PROJECT_DIR)}`);
if (spawnSync('xcodebuild', ['-version'], { encoding: 'utf8' }).status !== 0) skip('xcodebuild is not available');

const derived = path.join(os.tmpdir(), 'nebulis-mac-usb-tests-dd');
const args = [
  '-project', 'NebulisDesktop.xcodeproj', '-scheme', 'NebulisDesktop', '-destination', 'platform=macOS',
  'test', ...CLASSES.flatMap(c => ['-only-testing', `NebulisDesktopTests/${c}`]),
  'CODE_SIGN_IDENTITY=-', 'CODE_SIGNING_ALLOWED=YES', 'DEVELOPMENT_TEAM=',
  '-derivedDataPath', derived,
];

const result = spawnSync('xcodebuild', args, { cwd: PROJECT_DIR, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 25 * 60 * 1000 });
const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
const executed = [...output.matchAll(/Executed (\d+) tests?, with (\d+) failures?/g)].pop();

if (result.status === 0) {
  console.log(`test:mac passed: ${executed ? `${executed[1]} tests, ${executed[2]} failures` : 'no test count reported'}`);
  process.exit(0);
}

const problems = output.split('\n').filter(l => /error: |Test Case .* failed|\*\* TEST FAILED|\*\* BUILD FAILED/.test(l)).slice(0, 40);
console.error(`test:mac FAILED (exit ${result.status ?? 'timeout'})${executed ? `: ${executed[1]} tests, ${executed[2]} failures` : ''}`);
console.error(problems.join('\n') || output.split('\n').slice(-40).join('\n'));
process.exit(result.status ?? 1);

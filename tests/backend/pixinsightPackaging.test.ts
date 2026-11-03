import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { resolveConnectorScriptPath } from '../../server/lib/pixinsightRepo';

/**
 * The PixInsight connector is not imported by any server code, so every packaging path has to carry it
 * by hand. Miss one and /plugins/pixinsight/ answers 500 in that build while every other test stays green.
 * This pins each hop: source tree, the three pkg builds (staging + asset list), and the Docker image.
 */

const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const SOURCE = 'server/assets/pixinsight/NebulisConnector.js';
const PKG_BUILDS = [
  { name: 'mac', script: 'scripts/build-mac.mjs', config: 'installers/macos/pkg.config.json', releaseDir: 'releases/mac' },
  { name: 'mac-legacy', script: 'scripts/build-mac.mjs', config: 'installers/macos/pkg-legacy.config.json', releaseDir: 'releases/mac-legacy' },
  { name: 'win', script: 'scripts/build-win.mjs', config: 'installers/windows/pkg.config.json', releaseDir: 'releases/win' },
];

describe('PixInsight connector packaging', () => {
  it('the script exists in the source tree and the server resolves it', () => {
    expect(fs.existsSync(path.join(ROOT, SOURCE))).toBe(true);
    expect(path.resolve(resolveConnectorScriptPath())).toBe(path.join(ROOT, SOURCE));
  });

  it('the script is PJSR, not Node JavaScript (which is why pkg builds stage it as .pjsr)', () => {
    expect(read(SOURCE)).toMatch(/^\s*#(engine|feature-id)/m);
  });

  describe.each(PKG_BUILDS)('$name build', ({ script, config, releaseDir }) => {
    it('build script copies the source script to assets/pixinsight/NebulisConnector.pjsr', () => {
      const src = read(script);
      expect(src).toContain("'assets', 'pixinsight'");
      expect(src).toContain("'server', 'assets', 'pixinsight', 'NebulisConnector.js'");
      expect(src).toContain("'NebulisConnector.pjsr'");
    });

    it('pkg config embeds the staged .pjsr as an asset, not as a compiled script', () => {
      const cfg = JSON.parse(read(config)) as { assets?: string[]; scripts?: string[] };
      expect(cfg.assets).toContain(`${releaseDir}/server/assets/pixinsight/NebulisConnector.pjsr`);
      const everything = JSON.stringify(cfg);
      expect(everything).not.toContain('NebulisConnector.js');
    });
  });

  describe('Docker image', () => {
    it('Dockerfile copies the whole server/ folder', () => {
      expect(read('docker/Dockerfile')).toMatch(/^COPY\s+(--\S+\s+)*server\/\s+\.\/server\/\s*$/m);
    });

    it('.dockerignore does not exclude the script', () => {
      const patterns = read('.dockerignore').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#') && !l.startsWith('!'));
      for (const p of patterns) {
        const rx = new RegExp('^' + p.replace(/^\//, '').replace(/\/$/, '').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*') + '(/.*)?$');
        expect(rx.test(SOURCE), `.dockerignore pattern "${p}" would drop ${SOURCE}`).toBe(false);
      }
    });
  });
});

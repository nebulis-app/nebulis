import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// Dynamically load the PixInsight module by stripping PJSR preprocessor directives
function loadPixInsightModule() {
  const filePath = path.join(process.cwd(), 'integrations/pixinsight/NebulisConnector.js');
  let code = fs.readFileSync(filePath, 'utf8');
  // Strip PJSR # directives
  code = code.replace(/^[#].*$/gm, '// PJSR directive');
  
  const mod: { exports: any } = { exports: {} };
  const fn = new Function('module', 'exports', code);
  fn(mod, mod.exports);
  return mod.exports;
}

describe('PixInsight Nebulis Connector Module', () => {
  let pluginModule: ReturnType<typeof loadPixInsightModule>;

  beforeEach(() => {
    pluginModule = loadPixInsightModule();
  });

  it('has its version strictly aligned with package.json', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    const scriptPath = path.join(process.cwd(), 'integrations/pixinsight/NebulisConnector.js');
    const content = fs.readFileSync(scriptPath, 'utf8');
    const m = content.match(/var\s+NEBULIS_VERSION\s*=\s*["']([^"']+)["']/);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(pkg.version);
  });

  describe('NebulisSettings', () => {
    it('initializes with sensible defaults', () => {
      const settings = new pluginModule.NebulisSettings();
      expect(settings.serverUrl).toBe('http://localhost:3002');
      expect(settings.apiKey).toBe('');
      expect(settings.tempTolerance).toBe(2.0);
      expect(settings.expTolerance).toBe(0.15);
      expect(settings.autoMatchCalibrations).toBe(true);
      expect(settings.fastDownloadMode).toBe(true);
      expect(settings.useDedicatedCalibrationsDir).toBe(false);
      expect(settings.lightsSubfolder).toBe('lights');
      expect(settings.calibrationsSubfolder).toBe('calibrations');
      expect(settings.projectSubfolder).toBe('processing_project');
    });

    it('resolves workspace directories for objects', () => {
      const settings = new pluginModule.NebulisSettings();
      settings.downloadDir = '/Users/astro/Projects';

      expect(settings.getResolvedWorkspaceDir('M42')).toBe('/Users/astro/Projects/M42');
      expect(settings.getResolvedLightsDir('M42')).toBe('/Users/astro/Projects/M42/lights');
      expect(settings.getResolvedProjectDir('M42')).toBe('/Users/astro/Projects/M42/processing_project');

      // Default calibration folder: inside object workspace
      expect(settings.getResolvedCalibrationsDir('M42')).toBe('/Users/astro/Projects/M42/calibrations');

      // Dedicated shared calibration library mode:
      settings.useDedicatedCalibrationsDir = true;
      settings.calibrationsDir = '/Users/astro/SharedCalibrations';
      expect(settings.getResolvedCalibrationsDir('M42')).toBe('/Users/astro/SharedCalibrations');
    });
  });

  describe('NebulisClient URL and Header generation', () => {
    it('normalizes base URLs by removing trailing slashes', () => {
      const settings = new pluginModule.NebulisSettings();
      settings.serverUrl = 'http://localhost:3000///';
      const client = new pluginModule.NebulisClient(settings);
      expect(client.normalizeBaseUrl()).toBe('http://localhost:3000');
    });

    it('injects API Key header when present', () => {
      const settings = new pluginModule.NebulisSettings();
      settings.apiKey = 'my-secret-key-123';
      const client = new pluginModule.NebulisClient(settings);
      const headers = client.getHeaders();
      expect(headers).toContain('Accept: application/json');
      expect(headers).toContain('X-API-Key: my-secret-key-123');
      expect(headers).toContain('Authorization: Bearer my-secret-key-123');
    });

    it('injects Bearer token header when authToken is present and apiKey is absent', () => {
      const settings = new pluginModule.NebulisSettings();
      settings.authToken = 'my-jwt-token-xyz';
      const client = new pluginModule.NebulisClient(settings);
      const headers = client.getHeaders();
      expect(headers).toContain('Accept: application/json');
      expect(headers).toContain('Authorization: Bearer my-jwt-token-xyz');
    });

    it('omits API Key header when empty or whitespace', () => {
      const settings = new pluginModule.NebulisSettings();
      settings.apiKey = '   ';
      const client = new pluginModule.NebulisClient(settings);
      const headers = client.getHeaders();
      expect(headers).toEqual(['Accept: application/json']);
    });

    it('unpacks nested calibration groups and settingsGroups from API response', () => {
      const settings = new pluginModule.NebulisSettings();
      const client = new pluginModule.NebulisClient(settings);

      // Mock request to return server calibration layout
      client.request = (_method: string, endpoint: string) => {
        if (endpoint === '/api/v1/library/calibrations') {
          return {
            ok: true,
            data: {
              groups: [
                {
                  type: 'dark',
                  typeLabel: 'Darks',
                  folderName: 'Plan/Dark',
                  scope: 'scope_123',
                  scopeLabel: 'Elendil',
                  fileCount: 38,
                  settingsGroups: [
                    {
                      key: '30|1|100|-7.8',
                      exposureSec: 30,
                      binning: 1,
                      gain: 100,
                      sensorTempC: -7.8,
                      fileCount: 38,
                      files: [
                        { name: 'Dark_30s_001.fit', size: 1000, info: { filterLabel: 'Dark' } }
                      ]
                    }
                  ]
                }
              ]
            }
          };
        }
        return { ok: false };
      };

      const cals = client.fetchCalibrations();
      expect(cals).toHaveLength(1);
      expect(cals[0].frameType).toBe('dark');
      expect(cals[0].scope).toBe('scope_123');
      expect(cals[0].scopeLabel).toBe('Elendil');
      expect(cals[0].key).toBe('30|1|100|-7.8');
      expect(cals[0].exposure).toBe(30);
      expect(cals[0].gain).toBe(100);
      expect(cals[0].sensorTempC).toBe(-7.8);
      expect(cals[0].fileCount).toBe(38);
    });

    it('formats body correctly for calibration download link', () => {
      const settings = new pluginModule.NebulisSettings();
      const client = new pluginModule.NebulisClient(settings);

      let requestedBody: any = null;
      client.request = (_method: string, endpoint: string, body: any) => {
        if (endpoint === '/api/v1/library/calibrations/download/link') {
          requestedBody = body;
          return {
            ok: true,
            data: { url: '/api/v1/library/calibrations/download/abc?t=123', filename: 'Darks.zip' }
          };
        }
        return { ok: false };
      };

      const res = client.requestCalibrationDownloadLink('scope_123', 'Plan/Dark', '30|1|100|-7.8');
      expect(requestedBody).toEqual({
        scope: 'scope_123',
        folderName: 'Plan/Dark',
        key: '30|1|100|-7.8'
      });
      expect(res.url).toContain('/api/v1/library/calibrations/download/');
    });
  });

  describe('CalibrationMatcher', () => {
    it('matches attached calibration groups with top confidence', () => {
      const settings = new pluginModule.NebulisSettings();
      const matcher = new pluginModule.CalibrationMatcher(settings);

      const selectedObject = { id: 'M42', name: 'Orion Nebula' };
      const sessions = [
        {
          sessionDate: '2026-03-01',
          camera: 'ASI2600MC',
          gain: 100,
          exposure: 180,
          sensorTempC: -10,
          binning: '1x1',
          filter: 'L'
        }
      ];

      const attachedCalibrations = [
        {
          groupKey: 'attached_dark_1',
          frameType: 'dark',
          camera: 'ASI2600MC',
          gain: 100,
          exposure: 180,
          sensorTempC: -10,
          binning: '1x1'
        }
      ];

      const matches = matcher.findMatches(selectedObject, sessions, [], attachedCalibrations);
      expect(matches.darks).toHaveLength(1);
      expect(matches.darks[0].score).toBe(100);
      expect(matches.darks[0].reason).toContain('Attached directly');
    });

    it('smart-matches darks within exposure and temperature tolerances', () => {
      const settings = new pluginModule.NebulisSettings();
      settings.tempTolerance = 2.0;
      settings.expTolerance = 0.15;
      const matcher = new pluginModule.CalibrationMatcher(settings);

      const selectedObject = { id: 'M31', name: 'Andromeda' };
      const sessions = [
        {
          sessionDate: '2026-03-05',
          camera: 'ZWO ASI2600MM Pro',
          gain: 100,
          exposure: 300,
          sensorTempC: -10,
          binning: '1x1',
          filter: 'Ha'
        }
      ];

      const libraryCalibrations = [
        // Matching dark: same camera, gain 100, exp 300s, temp -10.5C (within 2C)
        {
          groupKey: 'lib_dark_good',
          frameType: 'dark',
          camera: 'ASI2600MM Pro',
          gain: 100,
          exposure: 300,
          sensorTempC: -10.5,
          binning: '1x1'
        },
        // Incompatible dark: different camera
        {
          groupKey: 'lib_dark_wrong_camera',
          frameType: 'dark',
          camera: 'QHY268M',
          gain: 100,
          exposure: 300,
          sensorTempC: -10,
          binning: '1x1'
        },
        // Incompatible dark: exposure 60s vs 300s
        {
          groupKey: 'lib_dark_short_exp',
          frameType: 'dark',
          camera: 'ASI2600MM Pro',
          gain: 100,
          exposure: 60,
          sensorTempC: -10,
          binning: '1x1'
        }
      ];

      const matches = matcher.findMatches(selectedObject, sessions, libraryCalibrations, []);
      expect(matches.darks).toHaveLength(1);
      expect(matches.darks[0].group.groupKey).toBe('lib_dark_good');
      expect(matches.darks[0].score).toBeGreaterThanOrEqual(70);
    });

    it('matches flats by optical filter and camera', () => {
      const settings = new pluginModule.NebulisSettings();
      const matcher = new pluginModule.CalibrationMatcher(settings);

      const selectedObject = { id: 'NGC7000', name: 'North America Nebula' };
      const sessions = [
        {
          sessionDate: '2026-03-10',
          camera: 'ASI2600MM Pro',
          gain: 100,
          binning: '1x1',
          filter: 'OIII'
        }
      ];

      const libraryCalibrations = [
        {
          groupKey: 'flat_oiii',
          frameType: 'flat',
          camera: 'ASI2600MM Pro',
          gain: 100,
          binning: '1x1',
          filter: 'OIII'
        },
        {
          groupKey: 'flat_sii',
          frameType: 'flat',
          camera: 'ASI2600MM Pro',
          gain: 100,
          binning: '1x1',
          filter: 'SII'
        }
      ];

      const matches = matcher.findMatches(selectedObject, sessions, libraryCalibrations, []);
      expect(matches.flats).toHaveLength(1);
      expect(matches.flats[0].group.groupKey).toBe('flat_oiii');
    });

    it('matches bias frames across same camera sensor and gain', () => {
      const settings = new pluginModule.NebulisSettings();
      const matcher = new pluginModule.CalibrationMatcher(settings);

      const selectedObject = { id: 'M51', name: 'Whirlpool' };
      const sessions = [
        {
          sessionDate: '2026-03-15',
          camera: 'ASI2600MM Pro',
          gain: 100,
          binning: '1x1',
          filter: 'L'
        }
      ];

      const libraryCalibrations = [
        {
          groupKey: 'bias_asi2600',
          frameType: 'bias',
          camera: 'ASI2600MM Pro',
          gain: 100,
          binning: '1x1'
        }
      ];

      const matches = matcher.findMatches(selectedObject, sessions, libraryCalibrations, []);
      expect(matches.bias).toHaveLength(1);
      expect(matches.bias[0].group.groupKey).toBe('bias_asi2600');
    });
  });
});

import { describe, expect, it } from 'vitest';
import { ssoFamily } from '../../src/lib/ssoFamily';

describe('ssoFamily', () => {
  it("names the family from SkyBoT's class", () => {
    expect(ssoFamily('MB>Inner')).toBe('mainBelt');
    expect(ssoFamily('MB>Outer')).toBe('mainBelt');
    expect(ssoFamily('NEA>Apollo')).toBe('nearEarth');
    expect(ssoFamily('Comet>JFC')).toBe('comet');
    expect(ssoFamily('KBO>Classical>Main')).toBe('transNeptunian');
    expect(ssoFamily('Trojan')).toBe('trojan');
    expect(ssoFamily('Mars-Crosser')).toBe('marsCrosser');
    expect(ssoFamily('Hungaria')).toBe('hungaria');
    expect(ssoFamily('Centaur')).toBe('centaur');
    expect(ssoFamily('Planet')).toBe('planet');
    expect(ssoFamily('')).toBe('other');
  });
});

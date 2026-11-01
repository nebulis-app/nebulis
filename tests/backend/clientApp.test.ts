import { describe, it, expect } from 'vitest';
import { parseClientPlatform } from '../../server/lib/clientApp';

describe('client app header', () => {
  it('reads the platform and version from the header and rejects junk', () => {
    expect(parseClientPlatform('Nebulis-iOS/2.1.2')).toEqual({ platform: 'Nebulis-iOS', version: '2.1.2' });
    expect(parseClientPlatform('Nebulis-iOS/2.2-beta.1')).toEqual({ platform: 'Nebulis-iOS', version: '2.2' });
    expect(parseClientPlatform('Nebulis-Mac/1.0')).toEqual({ platform: 'Nebulis-Mac', version: '1.0' });
    for (const bad of [undefined, '', 'Mozilla/5.0', 'Nebulis-iOS/', 'Nebulis-iOS/abc', 'Nebulis-iOS/1.2.3.4', ['x']]) {
      expect(parseClientPlatform(bad)).toBeNull();
    }
  });
});

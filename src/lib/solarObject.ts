/** True for the Sun's library object. Its captures are made in daylight, so pages that say "Nights" say "Days" for it. */
export function isSunObject(objectId: string): boolean {
  const key = objectId.toLowerCase().replace(/[^a-z]/g, '');
  return key === 'sun' || key === 'solar';
}

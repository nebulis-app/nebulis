/**
 * The family of a solar-system body, for the Annotate card, from IMCCE SkyBoT's class: `MB>Inner`, `NEA>Apollo`,
 * `Comet>JFC`, `KBO>Classical`… Only the part before `>` is used; the card shows the full class beside it.
 */
export type SsoFamily = 'mainBelt' | 'nearEarth' | 'comet' | 'trojan' | 'transNeptunian' | 'centaur' | 'marsCrosser' | 'hungaria' | 'planet' | 'other';

export function ssoFamily(bodyClass: string): SsoFamily {
  const head = bodyClass.split('>')[0].trim().toLowerCase();
  if (head === 'mb') return 'mainBelt';
  if (head === 'nea') return 'nearEarth';
  if (head === 'comet') return 'comet';
  if (head === 'trojan') return 'trojan';
  if (head === 'kbo' || head === 'tno') return 'transNeptunian';
  if (head === 'centaur') return 'centaur';
  if (head === 'mars-crosser') return 'marsCrosser';
  if (head === 'hungaria') return 'hungaria';
  if (head === 'planet' || head === 'dwarf planet') return 'planet';
  return 'other';
}

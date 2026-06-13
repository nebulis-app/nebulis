/**
 * Canonical ID resolution for cross-catalog aliases.
 *
 * Every object has exactly one canonical ID — the "most primary" designation
 * across all catalog tiers. All image files and catalogCache rows are keyed
 * under the canonical ID so lookups always hit regardless of which alias the
 * caller provides.
 *
 * Priority: M# > NGC#/IC# > Sh2-N > C# (Caldwell resolves to NGC/IC)
 *
 * Coverage:
 *   - Caldwell C1–C109 → NGC/IC (109 entries)
 *   - Sharpless Sh2-N → M# or NGC/IC where a cross-reference exists (39 entries)
 */

/** Maps normalised alias (uppercase, no spaces) → canonical ID string. */
const ALIASES = new Map<string, string>([
  // ── Sharpless → Messier (same physical nebula, M# is canonical) ──────────
  ['SH2-25',  'M8'],
  ['SH2-30',  'M20'],
  ['SH2-45',  'M17'],
  ['SH2-49',  'M16'],
  ['SH2-244', 'M1'],
  ['SH2-281', 'M42'],

  // ── Sharpless → NGC/IC (NGC/IC is canonical) ─────────────────────────────
  ['SH2-1',   'IC1470'],
  ['SH2-6',   'NGC6302'],
  ['SH2-8',   'NGC6334'],
  ['SH2-11',  'NGC6357'],
  ['SH2-29',  'NGC6559'],
  ['SH2-37',  'IC1283'],
  ['SH2-86',  'NGC6820'],
  ['SH2-105', 'NGC6888'],
  ['SH2-117', 'NGC7000'],
  ['SH2-125', 'IC5146'],
  ['SH2-142', 'NGC7380'],
  ['SH2-158', 'NGC7538'],
  ['SH2-162', 'NGC7635'],
  ['SH2-171', 'NGC7822'],
  ['SH2-184', 'NGC281'],
  ['SH2-199', 'IC1848'],
  ['SH2-211', 'NGC1624'],
  ['SH2-220', 'NGC1499'],
  ['SH2-222', 'NGC1579'],
  ['SH2-229', 'IC405'],
  ['SH2-237', 'NGC1931'],
  ['SH2-238', 'NGC1555'],
  ['SH2-248', 'IC443'],
  ['SH2-273', 'NGC2264'],
  ['SH2-277', 'NGC2024'],
  ['SH2-279', 'NGC1973'],
  ['SH2-298', 'NGC2359'],
  ['SH2-311', 'NGC2467'],

  // ── Caldwell C# → NGC/IC ─────────────────────────────────────────────────
  ['C1',  'NGC188'],  ['C2',  'NGC40'],    ['C3',  'NGC4236'], ['C4',  'NGC7023'],
  ['C5',  'IC342'],   ['C6',  'NGC6543'],  ['C7',  'NGC2403'], ['C8',  'NGC559'],
  ['C10', 'NGC663'],  ['C11', 'NGC7635'],  ['C12', 'NGC6946'], ['C13', 'NGC457'],
  ['C14', 'NGC869'],  ['C15', 'NGC6826'],  ['C16', 'NGC7243'], ['C17', 'NGC147'],
  ['C18', 'NGC185'],  ['C19', 'IC5146'],   ['C20', 'NGC7000'], ['C21', 'NGC4449'],
  ['C22', 'NGC7662'], ['C23', 'NGC891'],   ['C24', 'NGC1275'], ['C25', 'NGC2419'],
  ['C26', 'NGC4244'], ['C27', 'NGC6888'],  ['C28', 'NGC752'],  ['C29', 'NGC5005'],
  ['C30', 'NGC7331'], ['C31', 'IC405'],    ['C32', 'NGC4631'], ['C33', 'NGC6992'],
  ['C34', 'NGC6960'], ['C35', 'NGC4889'],  ['C36', 'NGC4559'], ['C37', 'NGC6885'],
  ['C38', 'NGC4565'], ['C39', 'NGC2392'],  ['C40', 'NGC3626'], ['C42', 'NGC7006'],
  ['C43', 'NGC7814'], ['C44', 'NGC7479'],  ['C45', 'NGC5248'], ['C46', 'NGC2261'],
  ['C47', 'NGC6934'], ['C48', 'NGC2775'],  ['C49', 'NGC2237'], ['C50', 'NGC2244'],
  ['C51', 'IC1613'],  ['C52', 'NGC4697'],  ['C53', 'NGC3115'], ['C54', 'NGC2506'],
  ['C55', 'NGC7009'], ['C56', 'NGC246'],   ['C57', 'NGC6822'], ['C58', 'NGC2360'],
  ['C59', 'NGC3242'], ['C60', 'NGC4038'],  ['C61', 'NGC4039'], ['C62', 'NGC247'],
  ['C63', 'NGC7293'], ['C64', 'NGC2362'],  ['C65', 'NGC253'],  ['C66', 'NGC5694'],
  ['C67', 'NGC1097'], ['C68', 'NGC6729'],  ['C69', 'NGC6302'], ['C70', 'NGC300'],
  ['C71', 'NGC2477'], ['C72', 'NGC55'],    ['C73', 'NGC1851'], ['C74', 'NGC3132'],
  ['C75', 'NGC6124'], ['C76', 'NGC6231'],  ['C77', 'NGC5128'], ['C78', 'NGC6541'],
  ['C79', 'NGC3201'], ['C80', 'NGC5139'],  ['C81', 'NGC6352'], ['C82', 'NGC6193'],
  ['C83', 'NGC4945'], ['C84', 'NGC5286'],  ['C85', 'IC2391'],  ['C86', 'NGC6397'],
  ['C87', 'NGC1261'], ['C88', 'NGC5823'],  ['C89', 'NGC6087'], ['C90', 'NGC2867'],
  ['C91', 'NGC3532'], ['C92', 'NGC3372'],  ['C93', 'NGC6752'], ['C94', 'NGC4755'],
  ['C95', 'NGC6025'], ['C96', 'NGC2516'],  ['C97', 'NGC3766'], ['C98', 'NGC4609'],
  ['C100', 'IC2944'], ['C101', 'NGC6744'], ['C102', 'NGC2070'], ['C103', 'NGC2547'],
  ['C104', 'NGC362'], ['C105', 'NGC4833'], ['C106', 'NGC104'],  ['C107', 'NGC6101'],
  ['C108', 'NGC4372'], ['C109', 'NGC3195'],
]);

/**
 * Resolve any catalog alias to its canonical ID.
 *
 * Canonical means: the single ID under which images and descriptions are
 * stored on disk and in catalogCache. Returns the input unchanged if no
 * alias entry exists (the ID is already canonical, or it is unknown).
 */
export function resolveCanonicalId(id: string): string {
  const key = id.toUpperCase().replace(/\s+/g, '');
  if (ALIASES.has(key)) return ALIASES.get(key)!;
  // Sharpless IDs: normalize to the all-uppercase form that libraryObjects uses
  // (normalizeObjectId strips spaces but doesn't change case, so a telescope
  // folder named "SH2-274" ends up as objectId "SH2-274"). The sharpless.json
  // source uses mixed-case "Sh2-N", which would cause a cache key mismatch
  // unless we normalize here.
  if (/^SH2-\d+$/.test(key)) return key;
  return id;
}

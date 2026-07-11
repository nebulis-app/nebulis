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
 *   - NGC/IC → Messier for all 110 Messier objects with NGC/IC designations
 *   - Caldwell C1–C109 → NGC/IC (C9→Sh2-155 since neither has an NGC/IC; C41
 *     Hyades has no higher catalog-number designation, so it stays canonical)
 *   - Sharpless Sh2-N → M# or NGC/IC where a cross-reference exists (39 entries)
 *   - Solar-system common names (Lunar→Moon, Solar→Sun) so cross-telescope
 *     capture-mode names fold into one card
 *
 * Note: M24 (Sagittarius Star Cloud), M40 (Winnecke 4), and M45 (Pleiades)
 * have no NGC/IC designations so no alias is needed for them.
 * M102 is disputed; mapped to NGC5866 (Spindle Galaxy) per modern consensus.
 */

/** Maps normalised alias (uppercase, no spaces) → canonical ID string. */
const ALIASES = new Map<string, string>([
  // ── NGC/IC → Messier (Messier is canonical) ──────────────────────────────
  ['NGC1952', 'M1'],   ['NGC7089', 'M2'],   ['NGC5272', 'M3'],
  ['NGC6121', 'M4'],   ['NGC5904', 'M5'],   ['NGC6405', 'M6'],
  ['NGC6475', 'M7'],   ['NGC6523', 'M8'],   ['NGC6333', 'M9'],
  ['NGC6254', 'M10'],  ['NGC6705', 'M11'],  ['NGC6218', 'M12'],
  ['NGC6205', 'M13'],  ['NGC6402', 'M14'],  ['NGC7078', 'M15'],
  ['NGC6611', 'M16'],  ['NGC6618', 'M17'],  ['NGC6613', 'M18'],
  ['NGC6273', 'M19'],  ['NGC6514', 'M20'],  ['NGC6531', 'M21'],
  ['NGC6656', 'M22'],  ['NGC6494', 'M23'],  ['IC4725',  'M25'],
  ['NGC6694', 'M26'],  ['NGC6853', 'M27'],  ['NGC6626', 'M28'],
  ['NGC6913', 'M29'],  ['NGC7099', 'M30'],  ['NGC224',  'M31'],
  ['NGC221',  'M32'],  ['NGC598',  'M33'],  ['NGC1039', 'M34'],
  ['NGC2168', 'M35'],  ['NGC1960', 'M36'],  ['NGC2099', 'M37'],
  ['NGC1912', 'M38'],  ['NGC7092', 'M39'],  ['NGC2287', 'M41'],
  ['NGC1976', 'M42'],  ['NGC1982', 'M43'],  ['NGC2632', 'M44'],
  ['NGC2437', 'M46'],  ['NGC2422', 'M47'],  ['NGC2548', 'M48'],
  ['NGC4472', 'M49'],  ['NGC2323', 'M50'],  ['NGC5194', 'M51'],
  ['NGC7654', 'M52'],  ['NGC5024', 'M53'],  ['NGC6715', 'M54'],
  ['NGC6809', 'M55'],  ['NGC6779', 'M56'],  ['NGC6720', 'M57'],
  ['NGC4579', 'M58'],  ['NGC4621', 'M59'],  ['NGC4649', 'M60'],
  ['NGC4303', 'M61'],  ['NGC6266', 'M62'],  ['NGC5055', 'M63'],
  ['NGC4826', 'M64'],  ['NGC3623', 'M65'],  ['NGC3627', 'M66'],
  ['NGC2682', 'M67'],  ['NGC4590', 'M68'],  ['NGC6637', 'M69'],
  ['NGC6681', 'M70'],  ['NGC6838', 'M71'],  ['NGC6981', 'M72'],
  ['NGC6994', 'M73'],  ['NGC628',  'M74'],  ['NGC6864', 'M75'],
  ['NGC650',  'M76'],  ['NGC651',  'M76'],  ['NGC1068', 'M77'],
  ['NGC2068', 'M78'],  ['NGC1904', 'M79'],  ['NGC6093', 'M80'],
  ['NGC3031', 'M81'],  ['NGC3034', 'M82'],  ['NGC5236', 'M83'],
  ['NGC4374', 'M84'],  ['NGC4382', 'M85'],  ['NGC4406', 'M86'],
  ['NGC4486', 'M87'],  ['NGC4501', 'M88'],  ['NGC4552', 'M89'],
  ['NGC4569', 'M90'],  ['NGC4548', 'M91'],  ['NGC6341', 'M92'],
  ['NGC2447', 'M93'],  ['NGC4736', 'M94'],  ['NGC3351', 'M95'],
  ['NGC3368', 'M96'],  ['NGC3587', 'M97'],  ['NGC4192', 'M98'],
  ['NGC4254', 'M99'],  ['NGC4321', 'M100'], ['NGC5457', 'M101'],
  ['NGC581',  'M103'], ['NGC4594', 'M104'],
  ['NGC3379', 'M105'], ['NGC4258', 'M106'], ['NGC6171', 'M107'],
  ['NGC3556', 'M108'], ['NGC3992', 'M109'], ['NGC205',  'M110'],

  // ── Solar-system common-name aliases ─────────────────────────────────────
  // Different telescopes name the same body differently (Dwarf uses "Lunar"/
  // "Solar" capture modes; Seestar uses "Moon"/"Sun"). Canonicalise so both
  // fold into one library card. Capture-mode suffixes (_photo/_video) are
  // stripped to the catalogId by normalizeCatalogId before this lookup.
  ['LUNAR', 'Moon'],
  ['SOLAR', 'Sun'],

  // ── Sharpless → Messier (same physical nebula, M# is canonical) ──────────
  ['SH2-25',  'M8'],
  ['SH2-30',  'M20'],
  ['SH2-45',  'M17'],
  ['SH2-49',  'M16'],
  ['SH2-244', 'M1'],
  ['SH2-281', 'M42'],

  // ── M102 → NGC5866 (Spindle Galaxy in Draco; most commonly accepted identification) ──
  ['M102',    'NGC5866'],

  // ── IC2118 ↔ NGC1909 (Witch Head Nebula — both designations in use) ───────
  ['NGC1909', 'IC2118'],

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
  // C9 (Cave Nebula) has no NGC/IC designation; it shares its position with
  // Sh2-155, which ranks above Caldwell, so both fold into the Sharpless id.
  ['C9',  'SH2-155'],
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

/** Reverse map: canonical ID (uppercase) → all aliases that resolve to it. */
const REVERSE_ALIASES = new Map<string, string[]>();
for (const [alias, canonical] of ALIASES) {
  const c = canonical.toUpperCase();
  if (!REVERSE_ALIASES.has(c)) REVERSE_ALIASES.set(c, []);
  REVERSE_ALIASES.get(c)!.push(alias);
}

/**
 * Return all Caldwell/Sharpless alias strings that point at this canonical ID.
 * Returns human-readable forms: 'C13', 'Sh2-298', etc.
 */
export function getAliasesFor(canonicalId: string): string[] {
  const key = canonicalId.toUpperCase().replace(/\s+/g, '');
  return (REVERSE_ALIASES.get(key) ?? []).map(a =>
    a.startsWith('SH2-') ? `Sh2-${a.slice(4)}` : a,
  );
}

/** All known aliases that map to the given canonical ID (e.g. "NGC7331" → ["C30"]). */
export function getAliasesForCanonical(canonicalId: string): string[] {
  return getAliasesFor(canonicalId);
}

/**
 * Apply the user's catalog-nomenclature preference to a canonical ID, for
 * naming purposes only (folder names, not the on-disk/DB canonical key).
 *
 * When `preferCaldwell` is set and the canonical ID has a Caldwell alias
 * (e.g. "IC342" ← "C5"), returns the Caldwell form instead. Otherwise returns
 * the canonical ID unchanged. Callers must keep using the canonical ID (from
 * `resolveCanonicalId`) as the dedup/storage key; only the folder name should
 * use this preference.
 */
export function applyCatalogPreference(canonicalId: string, preferCaldwell: boolean): string {
  if (!preferCaldwell) return canonicalId;
  const caldwellAlias = getAliasesFor(canonicalId).find(a => /^C\d+$/.test(a));
  return caldwellAlias ?? canonicalId;
}

/**
 * Expand a search term to include its canonical ID and all known aliases.
 * Used so searching "C30" finds NGC7331 and vice-versa.
 * Returns unique terms; the original term is always first.
 */
export function expandSearchAliases(term: string): string[] {
  const terms = new Set<string>([term]);
  const canonical = resolveCanonicalId(term.trim());
  if (canonical !== term.trim()) terms.add(canonical);
  for (const alias of getAliasesForCanonical(canonical)) {
    terms.add(alias);
  }
  return Array.from(terms);
}

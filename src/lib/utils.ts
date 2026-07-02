export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Compile-time exhaustiveness guard for discriminated union switches. */
export function assertNever(x: never): never {
  throw new Error(`Unhandled variant: ${JSON.stringify(x)}`);
}

/**
 * Strip leading zeros from NGC/IC catalog IDs for display:
 * "NGC04884" → "NGC4884", "IC0434" → "IC434". No-op for other identifiers.
 */
export function cleanCatalogId(id: string): string {
  return id.replace(/^(NGC|IC)\s*0*(\d+)/i, (_, prefix, num) => `${prefix.toUpperCase()}${num}`);
}

/**
 * Returns "M81 - Bode's Galaxy" when the display name differs from the catalog
 * id (case-insensitive), or just the catalog id otherwise.
 * Mirrors iOS plannerObjectLabel().
 */
export function formatObjectName(id: string, name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.toLowerCase() === id.toLowerCase()) return id;
  // "Messier 61" is redundant when id is "M61"
  const messierMatch = trimmed.match(/^Messier\s+(\d+)$/i);
  if (messierMatch && id.toUpperCase() === `M${messierMatch[1]}`) return id;
  return `${id} - ${trimmed}`;
}


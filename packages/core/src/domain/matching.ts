import type { Metadata, Tags } from '@testlease/protocol';

/**
 * Deterministic matching: a resource is eligible when every requested tag equals the
 * stringified metadata value under the same key. Missing keys never match.
 */
export function matchesTags(metadata: Metadata, tags: Tags | undefined): boolean {
  if (!tags) return true;
  for (const [key, wanted] of Object.entries(tags)) {
    if (!(key in metadata)) return false;
    if (String(metadata[key]) !== wanted) return false;
  }
  return true;
}

/** Distinct known values per requested key across a set of resources (for diagnostics). */
export function knownTagValues(
  resources: { metadata: Metadata }[],
  keys: string[],
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const key of keys) {
    const values = new Set<string>();
    for (const r of resources) {
      if (key in r.metadata) values.add(String(r.metadata[key]));
    }
    out[key] = [...values].sort();
  }
  return out;
}

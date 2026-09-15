import type { Tags } from '@testlease/protocol';

/**
 * Deterministic matching: a resource is eligible when every requested tag equals the
 * resource's tag under the same key. Missing keys never match. Metadata is not consulted.
 */
export function matchesTags(resourceTags: Tags, requested: Tags | undefined): boolean {
  if (!requested) return true;
  for (const [key, wanted] of Object.entries(requested)) {
    if (!(key in resourceTags)) return false;
    if (resourceTags[key] !== wanted) return false;
  }
  return true;
}

/** Distinct known values per requested key across a set of resources (for diagnostics). */
export function knownTagValues(
  resources: { tags: Tags }[],
  keys: string[],
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const key of keys) {
    const values = new Set<string>();
    for (const r of resources) {
      if (key in r.tags) values.add(r.tags[key]!);
    }
    out[key] = [...values].sort();
  }
  return out;
}

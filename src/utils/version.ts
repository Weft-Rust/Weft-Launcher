export function parseTag(s: string): number[] {
  return s.replace(/^v/i, '').split(/[.\-]/).map((n) => parseInt(n, 10) || 0);
}

export function compareTags(a: string, b: string): number {
  const x = parseTag(a);
  const y = parseTag(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d;
  }
  return 0;
}

/**
 * Returns the latest release tag (highest published_at) from the releases list,
 * ignoring prereleases. Returns null if releases is empty or not loaded.
 */
export function getLatestTag(releases: { tag: string; published_at: string; prerelease: boolean }[]): string | null {
  if (!releases || releases.length === 0) return null;
  const nonPrereleases = releases.filter((r) => !r.prerelease);
  if (nonPrereleases.length === 0) return null;
  const sorted = [...nonPrereleases].sort(
    (a, b) => new Date(b.published_at).getTime() - new Date(a.published_at).getTime()
  );
  return sorted[0].tag;
}

/**
 * The tag that gets the NEW badge: the latest release, if it isn't installed
 * and at least one other version is.
 */
export function getNewTag(latestTag: string | null, installedVersions: { tag: string }[]): string | null {
  if (!latestTag || installedVersions.length === 0) return null;
  return installedVersions.some((v) => v.tag === latestTag) ? null : latestTag;
}

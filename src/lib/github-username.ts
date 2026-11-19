export function canonicalizeGithubUsername(raw: unknown): string | null {
  if (typeof raw !== "string") return null;

  const canonical = raw.trim().toLowerCase().replace(/^@/, "");
  return /^[a-z0-9_-]{1,39}$/.test(canonical) ? canonical : null;
}

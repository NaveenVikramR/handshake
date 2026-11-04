// The demo reset wipes payment data, so it needs more than DEMO_MODE (D26): DEMO_DATABASE_HOST must
// name the host DATABASE_URL points at. Moving DATABASE_URL to another database (M11: Neon `main`)
// changes the host, and the reset stops being offered, even if DEMO_MODE was left on.
export function demoDatabaseMatches(databaseUrl: string | undefined, demoHost: string | undefined): boolean {
  if (!databaseUrl || !demoHost?.trim()) return false;
  try {
    return new URL(databaseUrl).hostname.toLowerCase() === demoHost.trim().toLowerCase();
  } catch {
    return false;
  }
}

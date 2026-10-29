// Fails fast with the names (never the values) of required env vars that are unset or empty.
// Used first in Render builds, so a missing dashboard variable reads as one clear line in the log.
// Usage: node scripts/require-env.mjs NAME [NAME...]
const missing = process.argv.slice(2).filter((name) => !process.env[name]?.trim());
if (missing.length > 0) {
  console.error(`Missing required env vars (set them in the Render dashboard): ${missing.join(", ")}`);
  process.exit(1);
}
console.log(`Required env vars present: ${process.argv.length - 2}`);

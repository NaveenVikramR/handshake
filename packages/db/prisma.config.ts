import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "prisma/config";

// Locally the repo-root .env holds the Neon `dev` branch URLs; on Render the env is injected.
const rootEnv = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

// Prisma 7: connection URLs live here, not in schema.prisma. The CLI (migrate) uses the
// direct, non-pooled URL; the runtime client uses the pooled DATABASE_URL via the pg adapter.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    // Optional so `prisma generate` (postinstall) works without a database; migrate fails loudly if unset.
    url: process.env.DIRECT_URL ?? "",
  },
});

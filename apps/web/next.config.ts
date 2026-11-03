import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// Local dev shares the repo-root env file with the services (Render sets real env vars instead).
const rootEnv = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

// The browser only ever talks to this origin (the WebAuthn origin). Server-side route handlers in
// app/api forward to the consumer and merchant services, adding credentials from httpOnly cookies.
const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Permissions-Policy", value: "publickey-credentials-get=(self), publickey-credentials-create=(self)" },
        ],
      },
    ];
  },
};

export default config;

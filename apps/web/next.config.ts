import type { NextConfig } from "next";

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

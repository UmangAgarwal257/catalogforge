import type { NextConfig } from "next";
import { getWebEnv } from "./src/lib/env";

getWebEnv();

const config: NextConfig = {
  transpilePackages: ["@catalogforge/shared", "@catalogforge/db", "@catalogforge/ingestion", "@catalogforge/review", "@catalogforge/enrichment", "@catalogforge/cleaning"],
  async headers() {
    return [{ source: "/:path*", headers: [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      { key: "Content-Security-Policy", value: "frame-ancestors 'none'; object-src 'none'; base-uri 'self'" },
      ...(process.env.NODE_ENV === "production" ? [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }] : []),
    ] }];
  }
};

export default config;

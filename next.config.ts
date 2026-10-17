import type { NextConfig } from "next";

const config: NextConfig = {
  serverExternalPackages: ["pg", "opening_hours", "@electric-sql/pglite", "@electric-sql/pglite-postgis"],
  poweredByHeader: false,
  async headers() {
    return [{ source: "/(.*)", headers: [
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Permissions-Policy", value: "geolocation=(self), camera=(), microphone=()" }
    ] }];
  }
};
export default config;

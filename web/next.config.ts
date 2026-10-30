import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* All pages are per-user and cookie-driven: no prerendering. */
  cacheComponents: false,
  partialPrefetching: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  basePath: "/advcal2025",
  images: {
    unoptimized: true,
  },
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;

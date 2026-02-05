import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'export',
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
  eslint: {
    // Skip ESLint during build (run separately in CI)
    ignoreDuringBuilds: true,
  },
  typescript: {
    // Skip type checking during build (run separately in CI)
    ignoreBuildErrors: true,
  },
};

export default nextConfig;

import type { NextConfig } from 'next';
const config: NextConfig = {
  devIndicators: false,
  transpilePackages: ['@codetogether/contracts'],
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${(process.env.API_URL ?? 'http://127.0.0.1:4000').replace(/\/$/, '')}/api/:path*`,
      },
    ];
  },
};
export default config;

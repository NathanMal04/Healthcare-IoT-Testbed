import { PHASE_DEVELOPMENT_SERVER } from 'next/constants.js';

/** @type {(phase: string) => import('next').NextConfig} */
const nextConfig = (phase) => ({
  output: 'export',
  // Local development only: proxy /dev-api/* to API Gateway so the browser makes
  // same-origin requests and the vzoniq.com-only CORS policy doesn't apply.
  // Headers (including the Cognito Authorization token) are forwarded unchanged.
  // Never part of the production build.
  ...(phase === PHASE_DEVELOPMENT_SERVER &&
    process.env.API_PROXY_TARGET && {
      async rewrites() {
        return [
          {
            source: '/dev-api/:path*',
            destination: `${process.env.API_PROXY_TARGET}/:path*`,
          },
        ];
      },
    }),
});

export default nextConfig;

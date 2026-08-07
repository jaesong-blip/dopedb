import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    useTypeScriptCli: true,
  },
  turbopack: {
    root: repoRoot,
  },
  async rewrites() {
    return [
      {
        source: "/ko",
        destination: "/?lang=ko",
      },
      {
        source: "/ko/privacy",
        destination: "/privacy?lang=ko",
      },
      {
        source: "/ko/terms",
        destination: "/terms?lang=ko",
      },
      {
        source: "/product-map",
        destination: "/product-map.html",
      },
    ];
  },
  async redirects() {
    return [
      {
        source: "/:path*",
        has: [{ type: "host", value: "dopedb-cjs1301.vercel.app" }],
        destination: "https://dopedb.dev/:path*",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;

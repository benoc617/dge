import path from "node:path";
import { fileURLToPath } from "node:url";

/** Real directory containing this config (cwd can differ under Next / Docker). */
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const disableDevIndicator = (() => {
  const v = process.env.NEXT_DISABLE_DEV_INDICATOR;
  if (!v) return false;
  const lower = v.toLowerCase();
  return v === "1" || lower === "true" || lower === "yes";
})();

/** Set in docker-compose for stable Turbopack dev in the Linux container. */
const isDockerCompose = process.env.SRX_DOCKER === "1";

/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // Next 16.1+ enables Turbopack dev FS cache by default. In Docker dev, stale/corrupt cache under
    // `.next` has been observed to crash or panic Turbopack. Disable in Compose; host `next dev` keeps the cache.
    ...(isDockerCompose ? { turbopackFileSystemCacheForDev: false } : {}),
  },
  // Pin root so Turbopack does not infer `src/app` as the project root (breaks postcss/lightningcss).
  turbopack: {
    root: __dirname,
  },
  ...(disableDevIndicator ? { devIndicators: false } : {}),
};

export default nextConfig;

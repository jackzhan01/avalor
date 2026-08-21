import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /*
   * Where the build lands, overridable.
   *
   * A `next dev` server holds `.next` open for as long as it runs, and on
   * Windows that makes `next build` fail on `.next/trace` with EPERM — not
   * loudly, it just hangs. This repo has several agents in it and a dev server
   * is usually up, so a build needs somewhere else to go:
   *
   *   NEXT_DIST_DIR=.next-build npm run build
   *
   * Unset it behaves exactly as before.
   */
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

export default nextConfig;

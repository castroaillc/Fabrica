import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Hide @carbon/styles' if() deprecation warnings; the app's own warnings still show.
  sassOptions: { quietDeps: true, silenceDeprecations: ["if-function"] },
};

export default nextConfig;

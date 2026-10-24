import type { NextConfig } from "next";
import { getWebEnv } from "./src/lib/env";

getWebEnv();

const config: NextConfig = {
  transpilePackages: ["@catalogforge/shared", "@catalogforge/db", "@catalogforge/ingestion", "@catalogforge/review", "@catalogforge/enrichment", "@catalogforge/cleaning"]
};

export default config;

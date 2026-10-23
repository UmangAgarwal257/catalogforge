import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";
import tseslint from "typescript-eslint";

export default defineConfig([
  globalIgnores(["**/node_modules/**", "**/.next/**", "**/generated/**", "**/next-env.d.ts"]),
  ...tseslint.configs.recommended,
  ...nextVitals.map((config) => ({ ...config, files: ["apps/web/**/*.{ts,tsx,js,mjs}"] })),
  ...nextTypescript.map((config) => ({ ...config, files: ["apps/web/**/*.{ts,tsx,js,mjs}"] })),
  { settings: { next: { rootDir: "apps/web/" } } }
]);

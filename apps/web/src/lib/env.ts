import { parseEnv, webEnvSchema } from "@catalogforge/shared";

export function getWebEnv() {
  return parseEnv(webEnvSchema, process.env);
}

import { parseEnv, workerEnvSchema } from "@catalogforge/shared";

export const env = parseEnv(workerEnvSchema, process.env);

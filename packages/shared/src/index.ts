export { databaseEnvSchema, webEnvSchema, workerEnvSchema, parseEnv } from "./env";

export type HealthStatus = {
  status: "ok" | "unavailable";
};

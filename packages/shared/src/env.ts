import { z } from "zod";

const postgresUrl = z.url().refine((value) => {
  if (!URL.canParse(value)) return false;
  const protocol = new URL(value).protocol;
  return protocol === "postgres:" || protocol === "postgresql:";
});
const redisUrl = z.url().refine((value) => {
  if (!URL.canParse(value)) return false;
  const protocol = new URL(value).protocol;
  return protocol === "redis:" || protocol === "rediss:";
});

export const databaseEnvSchema = z.object({ DATABASE_URL: postgresUrl });
export const webEnvSchema = databaseEnvSchema.extend({
  WEB_APP_URL: z.url().refine((value) => URL.canParse(value) && ["http:", "https:"].includes(new URL(value).protocol))
});
export const workerEnvSchema = databaseEnvSchema.extend({
  REDIS_URL: redisUrl,
  WORKER_HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(3001)
});

// Report variable names only: validation errors must not echo credentials.
export function parseEnv<T>(schema: z.ZodType<T>, input: Record<string, string | undefined>): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    const keys = [...new Set(result.error.issues.map((issue) => issue.path.join(".")))];
    throw new Error(`Invalid or missing environment variables: ${keys.join(", ")}`);
  }
  return result.data;
}

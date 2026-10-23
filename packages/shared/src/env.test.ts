import { describe, expect, it } from "vitest";
import { parseEnv, webEnvSchema, workerEnvSchema } from "./env";

const valid = {
  DATABASE_URL: "postgresql://test:local@127.0.0.1:5432/test",
  REDIS_URL: "redis://127.0.0.1:6379",
  WEB_APP_URL: "http://localhost:3000"
};

describe("environment validation", () => {
  it("validates worker configuration and defaults its health port", () => {
    expect(parseEnv(workerEnvSchema, valid).WORKER_HEALTH_PORT).toBe(3001);
  });
  it("does not require future AI or storage credentials", () => {
    expect(parseEnv(webEnvSchema, valid).WEB_APP_URL).toBe(valid.WEB_APP_URL);
  });
  it("rejects missing connection settings", () => {
    expect(() => parseEnv(workerEnvSchema, {})).toThrow("DATABASE_URL, REDIS_URL");
  });
  it.each(["0", "65536", "abc", "1.5"])("rejects invalid port %s", (port) => {
    expect(() => parseEnv(workerEnvSchema, { ...valid, WORKER_HEALTH_PORT: port })).toThrow("WORKER_HEALTH_PORT");
  });
  it("does not include an invalid secret value in errors", () => {
    const secret = "https://private-password@example.com";
    expect(() => parseEnv(workerEnvSchema, { ...valid, DATABASE_URL: secret })).toThrow(/^Invalid or missing environment variables: DATABASE_URL$/);
  });
  it("rejects non-Redis connection protocols", () => {
    expect(() => parseEnv(workerEnvSchema, { ...valid, REDIS_URL: "https://localhost" })).toThrow("REDIS_URL");
  });
  it("handles malformed URLs without exposing their value", () => {
    expect(() => parseEnv(webEnvSchema, { ...valid, DATABASE_URL: "malformed-private-value" })).toThrow(/^Invalid or missing environment variables: DATABASE_URL$/);
  });
});

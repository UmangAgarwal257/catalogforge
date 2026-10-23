import type { HealthStatus } from "@catalogforge/shared";
import { checkDatabase } from "@catalogforge/db";
import type { Redis } from "ioredis";

export async function checkReadiness(redis: Redis): Promise<HealthStatus> {
  try {
    // Fail fast when Redis is disconnected instead of buffering a health command.
    if (redis.status !== "ready") return { status: "unavailable" };
    await Promise.all([checkDatabase(), redis.ping()]);
    return { status: "ok" };
  } catch {
    return { status: "unavailable" };
  }
}

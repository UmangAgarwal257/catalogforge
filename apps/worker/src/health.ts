import type { HealthStatus } from "@catalogforge/shared";
import { checkDatabase } from "@catalogforge/db";
import type { Redis } from "ioredis";

export async function checkReadiness(
  redis: Redis,
  consumer?: { isAvailable(): Promise<boolean> },
  shuttingDown = false
): Promise<HealthStatus> {
  try {
    // Fail fast when Redis is disconnected instead of buffering a health command.
    if (shuttingDown || redis.status !== "ready") return { status: "unavailable" };
    const [, , consumerAvailable] = await Promise.all([checkDatabase(), redis.ping(), consumer?.isAvailable() ?? true]);
    if (!consumerAvailable) return { status: "unavailable" };
    return { status: "ok" };
  } catch {
    return { status: "unavailable" };
  }
}

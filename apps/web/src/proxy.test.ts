import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({ claims: null as Record<string, unknown> | null, error: null as Error | null, calls: 0 }));
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({ auth: { getClaims: async () => { state.calls++; return { data: { claims: state.claims }, error: state.error }; } } }),
}));

import { proxy } from "./proxy";

describe("production auth proxy", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("DEV_INGESTION_ENABLED", "false");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "publishable-test-key");
    state.claims = null;
    state.error = null;
    state.calls = 0;
  });

  it("requires a verified session for merchant APIs and returns a safe 401", async () => {
    const response = await proxy(new NextRequest("https://catalog.example/api/imports"));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { code: "UNAUTHENTICATED", message: "Sign in to access this resource." } });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(state.calls).toBe(1);
  });

  it("does not bypass authentication in development mode", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DEV_INGESTION_ENABLED", "true");
    const response = await proxy(new NextRequest("http://localhost:3000/api/imports"));
    expect(response.status).toBe(401);
    expect(state.calls).toBe(1);
  });

  it("keeps health and published-media routes public while protecting review media and merchant pages", async () => {
    const ready = await proxy(new NextRequest("https://catalog.example/api/ready"));
    expect(ready.headers.get("x-middleware-next")).toBe("1");
    const publishedImage = await proxy(new NextRequest("https://catalog.example/api/media/00000000-0000-4000-8000-000000000001"));
    expect(publishedImage.headers.get("x-middleware-next")).toBe("1");
    const reviewImage = await proxy(new NextRequest("https://catalog.example/api/media/00000000-0000-4000-8000-000000000001?scope=review"));
    expect(reviewImage.status).toBe(401);
    const loginRedirect = await proxy(new NextRequest("https://catalog.example/products"));
    expect(loginRedirect.status).toBe(307);
    expect(loginRedirect.headers.get("location")).toContain("/login?next=%2Fproducts");
    state.claims = { sub: "00000000-0000-4000-8000-000000000042" };
    const page = await proxy(new NextRequest("https://catalog.example/products"));
    expect(page.headers.get("cache-control")).toBe("private, no-store");
  });
});

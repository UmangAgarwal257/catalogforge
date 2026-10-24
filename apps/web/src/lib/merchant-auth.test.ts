import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  claims: null as Record<string, unknown> | null,
  error: null as Error | null,
  members: [] as Array<{ storeId: string; role: string }>,
  query: undefined as unknown,
}));

vi.mock("@catalogforge/db", () => ({
  getDb: () => ({ storeMember: { findMany: async (query: unknown) => { state.query = query; return state.members; } } }),
}));
vi.mock("./supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getClaims: async () => ({ data: { claims: state.claims }, error: state.error }) } }),
}));

import { withMerchantStore } from "./merchant-auth";

const userId = "00000000-0000-4000-8000-000000000042";
const storeId = "00000000-0000-4000-8000-000000000001";
const otherStoreId = "00000000-0000-4000-8000-000000000099";

function request(method = "GET", origin = "https://catalog.example", query = "") {
  return new Request(`https://catalog.example/api/dashboard${query}`, { method, headers: { origin } });
}

describe("merchant store authorization", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("WEB_APP_URL", "https://catalog.example");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "test-publishable-key");
    vi.stubEnv("SUPABASE_URL", "https://project.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-server-only-key");
    vi.stubEnv("SUPABASE_STORAGE_BUCKET", "catalogforge-private");
    vi.stubEnv("STOREFRONT_STORE_ID", storeId);
    state.claims = { sub: userId };
    state.error = null;
    state.members = [{ storeId, role: "OWNER" }];
    state.query = undefined;
  });

  it("derives API scope from the authenticated user's store membership, ignoring client store IDs", async () => {
    const response = await withMerchantStore(request("GET", "https://catalog.example", `?storeId=${otherStoreId}`), async authorizedStoreId => Response.json({ storeId: authorizedStoreId }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ storeId });
    expect(state.query).toEqual(expect.objectContaining({ where: { authUserId: userId } }));
  });

  it("denies unauthenticated and cross-origin requests before the action runs", async () => {
    const action = vi.fn(async () => Response.json({ ok: true }));
    state.claims = null;
    expect((await withMerchantStore(request(), action)).status).toBe(401);
    expect((await withMerchantStore(request("GET", "https://attacker.example"), action)).status).toBe(403);
    expect(action).not.toHaveBeenCalled();
  });

  it("does not enable an anonymous store identity when running the developer server", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DEV_INGESTION_ENABLED", "true");
    vi.stubEnv("DEV_STORE_ID", storeId);
    state.claims = null;
    const action = vi.fn(async () => Response.json({ ok: true }));
    expect((await withMerchantStore(request(), action)).status).toBe(401);
    expect(action).not.toHaveBeenCalled();
  });

  it("denies writes for viewer memberships and fails closed on missing production configuration", async () => {
    state.members = [{ storeId, role: "VIEWER" }];
    const action = vi.fn(async () => Response.json({ ok: true }));
    expect((await withMerchantStore(request("POST"), action)).status).toBe(403);
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    expect((await withMerchantStore(request(), action)).status).toBe(503);
    expect(action).not.toHaveBeenCalled();
  });
});

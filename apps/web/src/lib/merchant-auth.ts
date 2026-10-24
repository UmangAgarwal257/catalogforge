import { getDb } from "@catalogforge/db";
import { createSupabaseServerClient } from "./supabase/server";
import { assertWebConfig } from "./production-config";

export class MerchantAuthError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function checkMerchantOrigin(request: Request) {
  const expected = process.env.WEB_APP_URL;
  if (!expected) throw new MerchantAuthError(503, "Merchant access is not configured.");
  const expectedOrigin = new URL(expected).origin;
  const origin = request.headers.get("origin");
  if (request.method !== "GET" && origin !== expectedOrigin) throw new MerchantAuthError(403, "Request origin is not allowed.");
  if (origin && origin !== expectedOrigin) throw new MerchantAuthError(403, "Request origin is not allowed.");
  if (request.headers.get("sec-fetch-site") === "cross-site") throw new MerchantAuthError(403, "Cross-site merchant requests are not allowed.");
}

export async function resolveMerchantStore(request: Request): Promise<{ storeId: string; role: string }> {
  checkMerchantOrigin(request);
  try { assertWebConfig(); }
  catch { throw new MerchantAuthError(503, "Merchant access is not configured."); }
  let claims: Record<string, unknown> | null;
  try {
    const { data, error } = await (await createSupabaseServerClient()).auth.getClaims();
    if (error) throw error;
    claims = data?.claims as Record<string, unknown> | null;
  } catch {
    throw new MerchantAuthError(503, "Authentication service is unavailable.");
  }
  if (typeof claims?.sub !== "string") throw new MerchantAuthError(401, "Sign in to access this store.");

  const memberships = await getDb().storeMember.findMany({ where: { authUserId: claims.sub }, orderBy: { createdAt: "asc" }, take: 2, select: { storeId: true, role: true } });
  if (!memberships.length) throw new MerchantAuthError(403, "Your account is not assigned to a store.");
  if (memberships.length > 1) throw new MerchantAuthError(409, "This account belongs to multiple stores; select a store before continuing.");
  const membership = memberships[0]!;
  if (request.method !== "GET" && membership.role === "VIEWER") throw new MerchantAuthError(403, "Your store role is read-only.");
  return { storeId: membership.storeId, role: membership.role };
}

export async function withMerchantStore(request: Request, action: (storeId: string) => Promise<Response>) {
  try {
    const scope = await resolveMerchantStore(request);
    const response = await action(scope.storeId);
    response.headers.set("Cache-Control", "private, no-store");
    response.headers.set("Vary", "Cookie, Authorization");
    return response;
  } catch (error) {
    if (error instanceof MerchantAuthError) return Response.json({ error: { code: "MERCHANT_ACCESS", message: error.message } }, { status: error.status, headers: { "Cache-Control": "private, no-store", "Vary": "Cookie, Authorization" } });
    return Response.json({ error: { code: "MERCHANT_ACCESS", message: "Merchant access could not be verified." } }, { status: 503, headers: { "Cache-Control": "private, no-store" } });
  }
}

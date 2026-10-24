/** Fail closed in every runtime when real merchant auth/storage settings are absent. */
export function assertWebConfig(): void {
  const required = [
    "WEB_APP_URL",
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_STORAGE_BUCKET",
    "STOREFRONT_STORE_ID",
  ];
  if (required.some((name) => !process.env[name]?.trim())) throw new Error("Web service configuration is incomplete.");
  try {
    const app = new URL(process.env.WEB_APP_URL!);
    const auth = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!);
    const storage = new URL(process.env.SUPABASE_URL!);
    if (app.protocol !== "https:" || auth.protocol !== "https:" || storage.origin !== auth.origin) throw new Error("Production endpoints are inconsistent.");
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(process.env.STOREFRONT_STORE_ID!)) throw new Error("Production store scope is invalid.");
  } catch {
    throw new Error("Web service endpoints or store scope are invalid.");
  }
}

import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

const publicPage = (path: string) => path === "/login" || path === "/shop" || path.startsWith("/shop/");

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const publicImage = /^\/api\/media\/[^/]+$/.test(pathname) && request.nextUrl.searchParams.get("scope") !== "review";
  const publicApi = pathname === "/api/health" || pathname === "/api/ready" || publicImage;
  const apiRequest = pathname.startsWith("/api/");
  if (publicApi || pathname.startsWith("/_next/") || pathname === "/favicon.ico" || publicPage(pathname)) return NextResponse.next();

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return apiRequest
    ? NextResponse.json({ error: { code: "AUTH_UNAVAILABLE", message: "Authentication is not configured." } }, { status: 503, headers: { "Cache-Control": "private, no-store" } })
    : new NextResponse("Authentication is not configured.", { status: 503 });
  let response = NextResponse.next({ request });
  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (items) => {
        for (const { name, value } of items) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of items) response.cookies.set(name, value, options);
      },
    },
  });
  const { data, error } = await supabase.auth.getClaims();
  if (error || typeof data?.claims?.sub !== "string") {
    if (apiRequest) return NextResponse.json({ error: { code: "UNAUTHENTICATED", message: "Sign in to access this resource." } }, { status: 401, headers: { "Cache-Control": "private, no-store", "Vary": "Cookie, Authorization" } });
    const login = new URL("/login", request.url);
    login.searchParams.set("next", request.nextUrl.pathname + request.nextUrl.search);
    return NextResponse.redirect(login);
  }
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};

import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Keeps a signed-in session fresh.
 *
 * Supabase access tokens are short-lived, and a Server Component cannot write
 * the refreshed cookie back. The middleware is the one place in a request that
 * can, so refreshing here is what keeps `/api/ai` from seeing a logged-in user
 * as anonymous an hour into a game.
 *
 * It returns immediately for anyone without an auth cookie. Almost every visit
 * to this app is anonymous — the notebook needs no account at all — and making
 * those visits pay for an auth round trip would be a tax on the common case to
 * serve the rare one.
 */
export async function middleware(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) return NextResponse.next();

  const hasSession = request.cookies
    .getAll()
    .some((cookie) => cookie.name.startsWith("sb-"));
  if (!hasSession) return NextResponse.next();

  let response = NextResponse.next({ request });

  const supabase = createServerClient(url, anon, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (list) => {
        for (const { name, value } of list) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of list) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // The call itself is the point: it refreshes the token as a side effect.
  await supabase.auth.getUser();

  return response;
}

export const config = {
  matcher: [
    /*
     * Everything except static assets and the artwork. The cover image is the
     * first thing every visitor loads; there is nothing to refresh on it.
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|webmanifest)$).*)",
  ],
};

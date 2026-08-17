import { NextResponse } from "next/server";
import { isConfigured, serverClient } from "@/lib/auth/supabase";

/**
 * The landing spot for the link inside a login email.
 *
 * The login screen asks for the six-digit code instead, because that works
 * when the mail app opens the link in a different browser than the one that
 * started the login — which on a phone it usually does. This route is the
 * fallback for people who tap the link anyway, and for that it has to exist:
 * without it the link lands on a 404 and the login looks broken.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next = url.searchParams.get("next") ?? "/menu";

  // Only ever redirect within this site: `next` arrives from a link in an
  // email, so treating it as a full URL would be an open redirect.
  const destination = next.startsWith("/") ? next : "/menu";

  if (!isConfigured() || !code) {
    return NextResponse.redirect(new URL("/login?error=link", url.origin));
  }

  const supabase = await serverClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(new URL("/login?error=link", url.origin));
  }

  return NextResponse.redirect(new URL(destination, url.origin));
}

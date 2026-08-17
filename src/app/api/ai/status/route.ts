import { NextResponse } from "next/server";
import { checkAccess } from "@/lib/auth/gate";

export const runtime = "nodejs";
/** Per-user answer; caching it would show one user another user's state. */
export const dynamic = "force-dynamic";

/**
 * What the AI button should say before anyone taps it.
 *
 * The same gate as the real route, asked without spending anything, so the two
 * can never disagree — a button that offers a call the gate will refuse is
 * worse than no button.
 */
export async function GET() {
  const access = await checkAccess();
  if (access.ok) return NextResponse.json({ allowed: true } as const);
  return NextResponse.json({
    allowed: false,
    reason: access.reason,
    message: access.error,
  });
}

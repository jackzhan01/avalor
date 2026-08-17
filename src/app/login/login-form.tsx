"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { browserClient, isConfigured } from "@/lib/auth/supabase-browser";
import { Button } from "@/components/ui/button";

/**
 * Email plus a six-digit code.
 *
 * Not the clickable link: on a phone the mail app opens links in its own
 * browser, which is not the one that started the login, and the sign-in then
 * fails for a reason the user cannot see. A code can be carried between apps
 * by hand, so it works everywhere the link does and in the cases it doesn't.
 */
export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next");
  const destination = next?.startsWith("/") ? next : "/menu";

  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(
    params.get("error") === "link" ? "那个登录链接失效了，用验证码重新登录。" : null,
  );

  if (!isConfigured()) {
    return (
      <p className="t-footnote text-[color:var(--label-secondary)]">
        这个部署没有接后端，不需要也无法登录。记录功能全部照常可用。
      </p>
    );
  }

  async function sendCode() {
    setBusy(true);
    setError(null);
    try {
      const { error } = await browserClient().auth.signInWithOtp({
        email: email.trim(),
        options: {
          // Also makes the link in the same email work, via /auth/callback.
          emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(destination)}`,
        },
      });
      if (error) throw error;
      setStep("code");
    } catch (err) {
      setError(err instanceof Error ? err.message : "发送失败，稍后再试。");
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    setBusy(true);
    setError(null);
    try {
      const { error } = await browserClient().auth.verifyOtp({
        email: email.trim(),
        token: code.trim(),
        type: "email",
      });
      if (error) throw error;
      router.push(destination);
      router.refresh();
    } catch {
      setError("验证码不对或已过期。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {step === "email" ? (
        <>
          <input
            type="email"
            inputMode="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            aria-label="邮箱"
            className="t-body min-h-[48px] w-full rounded-[12px] bg-[color:var(--fill)] px-3.5 outline-none"
          />
          <Button
            fullWidth
            size="lg"
            onClick={() => void sendCode()}
            disabled={busy || !email.includes("@")}
          >
            {busy ? "发送中…" : "发送验证码"}
          </Button>
        </>
      ) : (
        <>
          <p className="t-footnote text-[color:var(--label-secondary)]">
            验证码已发到 {email}，六位数字。
          </p>
          <input
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            placeholder="123456"
            aria-label="验证码"
            className="t-title2 min-h-[52px] w-full rounded-[12px] bg-[color:var(--fill)] px-3.5 text-center tabular-nums tracking-[0.3em] outline-none"
          />
          <Button
            fullWidth
            size="lg"
            onClick={() => void verify()}
            disabled={busy || code.length < 6}
          >
            {busy ? "验证中…" : "登录"}
          </Button>
          <button
            onClick={() => {
              setStep("email");
              setCode("");
              setError(null);
            }}
            className="t-footnote text-[color:var(--blue)] active:opacity-60"
          >
            换个邮箱
          </button>
        </>
      )}

      {error && (
        <p className="t-footnote text-[color:var(--red)]" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

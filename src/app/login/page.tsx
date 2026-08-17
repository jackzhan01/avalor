import { Suspense } from "react";
import { PageHeader } from "@/components/ui/page-header";
import { LoginForm } from "./login-form";

export const metadata = { title: "登录 · Avalor" };

/**
 * The only screen in the app that asks for an account.
 *
 * It says so out loud. The notebook works with no account, offline, forever;
 * signing in buys exactly one thing, and a user who lands here by accident
 * should be able to see that in a sentence and leave.
 */
export default function LoginPage() {
  return (
    <main className="mx-auto min-h-dvh max-w-md px-4 pb-10">
      <PageHeader
        back={{ href: "/menu", label: "返回菜单" }}
        title="登录"
        subtitle="记录功能不需要账号。登录只为了用 AI 内测功能。"
      />
      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>
      <p className="t-caption mt-8 text-[color:var(--label-tertiary)]">
        我们只存你的邮箱和 AI 用量。牌局记录始终留在这台设备上，不会上传。
      </p>
    </main>
  );
}

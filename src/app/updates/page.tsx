"use client";

import { useEffect } from "react";
import { PageHeader } from "@/components/ui/page-header";
import { LATEST_VERSION, UPDATES, markUpdatesSeen } from "@/lib/updates";

/**
 * 更新了什么。
 *
 * 打开就算看过 —— 红点在离开这一页时就该消失，而不是要求再点一次「知道了」。
 */
export default function UpdatesPage() {
  useEffect(() => {
    markUpdatesSeen(LATEST_VERSION);
  }, []);

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col px-4 pb-10">
      <PageHeader back={{ href: "/menu", label: "返回菜单" }} />

      <div className="mb-6">
        <h1 className="t-title2">更新了什么</h1>
        <p className="t-subhead mt-1 text-[color:var(--label-secondary)]">
          每次上线，这里记下你能感觉到的变化
        </p>
      </div>

      <div className="flex flex-col gap-8">
        {UPDATES.map((entry, index) => (
          <section key={entry.version} className="flex flex-col gap-3">
            <div className="flex items-baseline gap-2">
              <span className="t-headline tabular-nums">v{entry.version}</span>
              {index === 0 && (
                <span className="t-caption rounded-full bg-[color:var(--fill-secondary)] px-2 py-0.5 text-[color:var(--label-secondary)]">
                  最新
                </span>
              )}
              <span className="t-caption ml-auto tabular-nums text-[color:var(--label-tertiary)]">
                {entry.date}
              </span>
            </div>

            <h2 className="t-body font-medium">{entry.title}</h2>

            <ul className="flex flex-col gap-2">
              {entry.highlights.map((line) => (
                <li
                  key={line}
                  className="t-subhead flex gap-2 text-[color:var(--label-secondary)]"
                >
                  <span aria-hidden className="text-[color:var(--label-tertiary)]">
                    ·
                  </span>
                  <span>{line}</span>
                </li>
              ))}
            </ul>

            {entry.caveats && entry.caveats.length > 0 && (
              <div className="rounded-xl bg-[color:var(--fill)] px-3 py-2.5">
                <p className="t-caption mb-1.5 text-[color:var(--label-tertiary)]">
                  上线时就知道的毛病
                </p>
                <ul className="flex flex-col gap-1.5">
                  {entry.caveats.map((line) => (
                    <li
                      key={line}
                      className="t-caption text-[color:var(--label-secondary)]"
                    >
                      {line}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        ))}
      </div>

      <p className="t-caption mt-10 text-[color:var(--label-tertiary)]">
        更早的改动没有记在这里 —— 那之前它还只是个记事本。
      </p>
    </main>
  );
}

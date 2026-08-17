"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Sheet } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { InlineWarning } from "@/components/ui/feedback";
import { useGameStore } from "@/lib/store/game-store";
import { useEvents, useGame } from "@/lib/store/hooks";
import { buildBriefing } from "@/lib/ai/briefing";
import {
  currentRoute,
  requestAnalysis,
  requestSpeech,
  type AiRoute,
} from "@/lib/ai/client";
import {
  CONFIDENCE_LABEL,
  readTone,
  type AiTask,
  type AnalysisResult,
  type SpeechResult,
} from "@/lib/ai/types";
import { NEEDS_LOGIN } from "@/lib/auth/messages";
import { ROLE_LABELS, seatOf } from "@/lib/format/labels";
import { cn } from "@/lib/utils/cn";

/**
 * The one screen in this app where information leaves the device.
 *
 * Everything else here is local-only, and that promise is load-bearing enough
 * that breaking it silently would be a betrayal — so the first use of either AI
 * feature stops and says exactly what is about to be sent and to whom, and the
 * briefing itself stays one tap away afterwards. The consent is remembered per
 * browser, not per game: it is a decision about the product, not about a hand.
 */

const CONSENT_KEY = "avalor.ai.consent.v1";

function hasConsent(): boolean {
  try {
    return localStorage.getItem(CONSENT_KEY) === "yes";
  } catch {
    return false; // private mode / storage disabled — ask every time
  }
}

function rememberConsent(): void {
  try {
    localStorage.setItem(CONSENT_KEY, "yes");
  } catch {
    /* not being able to remember is fine; asking again is the safe failure */
  }
}

type Phase = "consent" | "loading" | "done" | "error";

const TONE_COLOR: Record<ReturnType<typeof readTone>, string> = {
  evil: "var(--red)",
  good: "var(--green)",
  neutral: "var(--label-tertiary)",
  self: "var(--blue)",
};

export function AiSheet({
  task,
  onClose,
  onScratchpadWritten,
}: {
  task: AiTask | null;
  onClose: () => void;
  /** Lets the page remount the scratchpad, which seeds its text once on mount. */
  onScratchpadWritten: () => void;
}) {
  const game = useGame();
  const events = useEvents();
  const setScratchpad = useGameStore((s) => s.setScratchpad);
  const showSnackbar = useGameStore((s) => s.showSnackbar);

  const router = useRouter();
  const pathname = usePathname();

  const [phase, setPhase] = useState<Phase>("consent");
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [speech, setSpeech] = useState<SpeechResult | null>(null);
  const [error, setError] = useState("");
  const [showBriefing, setShowBriefing] = useState(false);
  /** Optional steer for the speech task, e.g. 「我想锤 4 号」. */
  const [steer, setSteer] = useState("");
  /**
   * Which path this run will take. Read once on mount rather than per render:
   * it comes from localStorage, so reading it during render would differ
   * between the server pass and the client one.
   */
  const [route, setRoute] = useState<AiRoute>("our-key");
  /** Guards against a second request while one is in flight. */
  const running = useRef(false);

  /*
   * Held in a ref rather than a useCallback on purpose. The request closes over
   * `events`, which changes whenever anything is recorded — as a dependency it
   * would re-fire the effect below and bill a second call mid-analysis. A ref
   * that is reassigned every render always sees fresh state without ever being
   * a dependency.
   */
  const run = useRef<(steer?: string) => void>(() => {});
  run.current = (steerText?: string) => {
    if (!game || !task || running.current) return;
    running.current = true;
    setPhase("loading");
    setError("");

    const request =
      task === "analysis"
        ? requestAnalysis(game, events)
        : requestSpeech(game, events, steerText?.trim() || undefined);

    void request
      .then((result) => {
        if (task === "analysis") setAnalysis(result as AnalysisResult);
        else setSpeech(result as SpeechResult);
        setPhase("done");
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "分析失败了。");
        setPhase("error");
      })
      .finally(() => {
        running.current = false;
      });
  };

  // Runs once per open: the page keys this component on the task, so switching
  // between the two features remounts it rather than reusing stale results.
  useEffect(() => {
    if (!task) return;
    setRoute(currentRoute());
    if (hasConsent()) run.current();
  }, [task]);

  if (!game || !task) return null;

  const isAnalysis = task === "analysis";
  const title = isAnalysis ? "局势分析" : "发言大纲";
  const viewerSeat = game.viewerPlayerId
    ? seatOf(game, game.viewerPlayerId)
    : null;

  /* ── Footer: whatever the current phase can actually do ───────────────── */

  let footer: React.ReactNode = null;
  if (phase === "consent") {
    footer = (
      <Button
        size="lg"
        fullWidth
        onClick={() => {
          rememberConsent();
          run.current();
        }}
      >
        明白了，开始{isAnalysis ? "分析" : "生成"}
      </Button>
    );
  } else if (phase === "error") {
    footer = (
      <Button size="lg" fullWidth onClick={() => run.current()}>
        再试一次
      </Button>
    );
  } else if (phase === "done" && !isAnalysis && speech) {
    footer = (
      <div className="flex gap-2">
        <Button
          size="lg"
          variant="gray"
          className="flex-1"
          onClick={() => run.current(steer)}
        >
          换一版
        </Button>
        <Button
          size="lg"
          className="flex-[2]"
          onClick={() => {
            const block = [
              speech.stance ? `【${speech.stance}】` : "",
              ...speech.outline.map((line) => `· ${line}`),
              speech.avoid?.length ? `别说：${speech.avoid.join("；")}` : "",
            ]
              .filter(Boolean)
              .join("\n");
            const existing = game.scratchpad?.trim();
            void setScratchpad(existing ? `${existing}\n\n${block}` : block);
            onScratchpadWritten();
            showSnackbar("已存进草稿");
            onClose();
          }}
        >
          存进草稿
        </Button>
      </div>
    );
  } else if (phase === "done" && isAnalysis) {
    footer = (
      <Button size="lg" variant="gray" fullWidth onClick={() => run.current()}>
        重新分析
      </Button>
    );
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title={title}
      subtitle={
        game.viewerRole
          ? `按你的身份「${ROLE_LABELS[game.viewerRole]}」来分析`
          : "还没填身份 — 填了会准很多"
      }
      layerKey={task}
      footer={footer}
    >
      {phase === "consent" && (
        <ConsentBody isAnalysis={isAnalysis} route={route} />
      )}

      {phase === "loading" && (
        <div className="flex flex-col items-center gap-3 px-6 py-14 text-center">
          <span
            aria-hidden
            className="h-7 w-7 animate-spin rounded-full border-2 border-[color:var(--fill-2)] border-t-[color:var(--blue)]"
          />
          <p className="t-callout font-medium text-[color:var(--label-secondary)]">
            模型正在读这局的记录…
          </p>
          <p className="t-footnote text-[color:var(--label-tertiary)]">
            通常几秒钟，别退出这个页面
          </p>
        </div>
      )}

      {phase === "error" && (
        <div className="flex flex-col gap-3 py-6">
          <InlineWarning>{error}</InlineWarning>
          {/*
           * A refusal that names a requirement has to offer the way to meet
           * it. Told 「需要先登录」 with no way to log in, the only move left
           * is to tap the button again, which cannot work.
           */}
          {error.includes(NEEDS_LOGIN) && (
            <Button
              fullWidth
              size="lg"
              onClick={() => router.push(`/login?next=${encodeURIComponent(pathname)}`)}
            >
              去登录
            </Button>
          )}
        </div>
      )}

      {phase === "done" && isAnalysis && analysis && (
        <AnalysisBody result={analysis} viewerSeat={viewerSeat} />
      )}
      {phase === "done" && !isAnalysis && speech && (
        <>
          <SpeechBody result={speech} />
          {/* Sits under the outline rather than in front of it: the default is
              one tap, and steering is what you do when the default missed. */}
          <div className="mt-5">
            <label
              htmlFor="ai-steer"
              className="t-caption mb-1.5 block px-1 uppercase tracking-[0.06em] text-[color:var(--label-secondary)]"
            >
              想换个方向？说一句，然后「换一版」
            </label>
            <input
              id="ai-steer"
              value={steer}
              onChange={(e) => setSteer(e.target.value)}
              placeholder="比如：我想锤 4 号 / 这轮我想低调"
              className="t-footnote w-full rounded-[10px] bg-[color:var(--bg-elevated)] px-3.5 py-3 outline-none placeholder:text-[color:var(--label-tertiary)]"
            />
          </div>
        </>
      )}

      {phase !== "consent" && (
        <div className="mt-6 border-t border-[color:var(--separator)] pt-3">
          <button
            onClick={() => setShowBriefing((v) => !v)}
            className="t-footnote min-h-[36px] w-full text-left text-[color:var(--label-tertiary)] active:opacity-60"
          >
            {showBriefing ? "▾" : "▸"} 看看发出去的是什么内容
          </button>
          {showBriefing && (
            <pre className="t-caption mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-[10px] bg-[color:var(--fill)] p-3 text-[color:var(--label-secondary)]">
              {buildBriefing(game, events)}
            </pre>
          )}
        </div>
      )}
    </Sheet>
  );
}

/* ── Bodies ────────────────────────────────────────────────────────────── */

function ConsentBody({
  isAnalysis,
  route,
}: {
  isAnalysis: boolean;
  route: AiRoute;
}) {
  const own = route === "own-key";
  return (
    <div className="flex flex-col gap-3 py-2">
      <p className="t-callout">
        这个功能要把<strong>这一局的记录</strong>发给模型服务商，才能
        {isAnalysis ? "分析" : "生成大纲"}。
      </p>

      {/* Which machines see this data is a different fact per route, and the
          BYOK user is entitled to know their data skips us entirely. */}
      <p className="t-footnote rounded-[10px] bg-[color:var(--fill)] px-3 py-2 text-[color:var(--label-secondary)]">
        {own ? (
          <>
            你用的是<strong className="text-[color:var(--label)]">自己的 API key</strong>
            ，请求由这台设备直接发给模型服务商，
            <strong className="text-[color:var(--label)]">不经过我们的服务器</strong>。
          </>
        ) : (
          <>
            你用的是<strong className="text-[color:var(--label)]">我们的额度</strong>
            ，请求会先经过我们的服务器再转给模型服务商。想让它完全不经过我们，可以在个人主页填自己的 API key。
          </>
        )}
      </p>
      <div className="rounded-[10px] bg-[color:var(--fill)] p-3">
        <p className="t-footnote mb-1.5 font-semibold text-[color:var(--label)]">
          会发出去的：
        </p>
        <ul className="t-footnote flex list-disc flex-col gap-1 pl-4 text-[color:var(--label-secondary)]">
          <li>座位、任务结果、每辆车和票型、保踩、意向车、跳派、女神、备注</li>
          <li>
            <strong className="text-[color:var(--orange)]">
              你自己的身份、视野和推测
            </strong>
            —— 不发这些，它就没法帮你找梅林
          </li>
        </ul>
        <p className="t-footnote mt-2.5 text-[color:var(--label-secondary)]">
          不会发的：其他对局的记录。你的记录仍然只存在这台设备上，只有你点这个按钮时才会发出去一份快照。
        </p>
      </div>
      <p className="t-footnote text-[color:var(--label-tertiary)]">
        点下面的按钮就表示你同意。之后不会再问，发出去的内容随时可以在结果页展开查看。
      </p>
    </div>
  );
}

function AnalysisBody({
  result,
  viewerSeat,
}: {
  result: AnalysisResult;
  viewerSeat: number | null;
}) {
  return (
    <div className="flex flex-col gap-5 py-1">
      <p className="t-callout font-semibold">{result.headline}</p>

      {result.seats.length > 0 && (
        <section>
          <h3 className="t-caption mb-2 px-1 uppercase tracking-[0.06em] text-[color:var(--label-secondary)]">
            每个座位
          </h3>
          <div className="flex flex-col gap-1.5">
            {result.seats.map((row) => {
              const tone = readTone(row.read);
              const isMe = viewerSeat != null && row.seat === viewerSeat;
              return (
                <div
                  key={row.seat}
                  className={cn(
                    "flex items-start gap-2.5 rounded-[10px] px-3 py-2.5",
                    isMe
                      ? "bg-[color:var(--fill-2)]"
                      : "bg-[color:var(--bg-elevated)]",
                  )}
                >
                  <span className="t-subhead w-11 shrink-0 font-semibold tabular-nums">
                    {row.seat}号
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="flex items-baseline gap-1.5">
                      <span
                        className="t-subhead font-semibold"
                        style={{ color: TONE_COLOR[tone] }}
                      >
                        {row.read}
                      </span>
                      <span className="t-caption text-[color:var(--label-tertiary)]">
                        {CONFIDENCE_LABEL[row.confidence]}
                      </span>
                    </p>
                    {row.why && (
                      <p className="t-footnote mt-0.5 text-[color:var(--label-secondary)]">
                        {row.why}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {result.keyPoints.length > 0 && (
        <section>
          <h3 className="t-caption mb-2 px-1 uppercase tracking-[0.06em] text-[color:var(--label-secondary)]">
            关键结论
          </h3>
          <ul className="flex flex-col gap-2">
            {result.keyPoints.map((point, i) => (
              <li key={i} className="t-footnote flex gap-2">
                <span
                  aria-hidden
                  className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-[color:var(--blue)]"
                />
                <span>{point}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {result.watchOut && <InlineWarning>{result.watchOut}</InlineWarning>}

      <p className="t-caption text-[color:var(--label-tertiary)]">
        这是模型的推测，不是答案。它看到的只有你记下来的东西。
      </p>
    </div>
  );
}

function SpeechBody({ result }: { result: SpeechResult }) {
  return (
    <div className="flex flex-col gap-5 py-1">
      {result.stance && (
        <p className="t-callout font-semibold">{result.stance}</p>
      )}

      <section>
        <h3 className="t-caption mb-2 px-1 uppercase tracking-[0.06em] text-[color:var(--label-secondary)]">
          按这个顺序说
        </h3>
        <ol className="flex flex-col gap-2.5">
          {result.outline.map((line, i) => (
            <li key={i} className="flex gap-2.5">
              <span className="t-caption mt-[3px] flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[color:var(--fill-2)] font-semibold tabular-nums text-[color:var(--blue)]">
                {i + 1}
              </span>
              <span className="t-callout">{line}</span>
            </li>
          ))}
        </ol>
      </section>

      {result.avoid && result.avoid.length > 0 && (
        <section>
          <h3 className="t-caption mb-2 px-1 uppercase tracking-[0.06em] text-[color:var(--label-secondary)]">
            这轮别说
          </h3>
          <ul className="flex flex-col gap-1.5">
            {result.avoid.map((line, i) => (
              <li key={i} className="t-footnote flex gap-2 text-[color:var(--orange)]">
                <span aria-hidden className="shrink-0">
                  ✕
                </span>
                <span>{line}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

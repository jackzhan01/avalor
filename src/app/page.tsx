"use client";

import { useRouter } from "next/navigation";

/**
 * The cover.
 *
 * A cover is a fixed object: it keeps its own colours regardless of the
 * viewer's theme, the way a printed one does. Tap anywhere to begin.
 *
 * The wordmark is set in Papyrus at the user's request. It is a system font on
 * macOS, iOS and Windows; Android has no equivalent and falls back through the
 * stack, which is the one place this cover will not look identical.
 */
export default function CoverPage() {
  const router = useRouter();

  return (
    <button
      onClick={() => router.push("/menu")}
      aria-label="开始"
      className="fixed inset-0 flex w-full flex-col items-center justify-center overflow-hidden"
      style={{
        background:
          "radial-gradient(125% 80% at 50% 12%, var(--cover-ground-2) 0%, var(--cover-ground) 62%)",
      }}
    >
      {/* Hairline frame, the way an inscription sits inside a cut border. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-[5vmin] border"
        style={{ borderColor: "rgba(236,230,216,0.14)" }}
      />

      <TableMark />

      <h1
        className="mt-[7vmin] text-[clamp(2.6rem,15vw,4.5rem)] leading-none"
        style={{
          fontFamily: "var(--font-display)",
          color: "var(--cover-ink)",
          letterSpacing: "0.12em",
          textIndent: "0.12em",
        }}
      >
        AVALOR
      </h1>

      <p
        className="mt-[4vmin] text-[clamp(0.75rem,3.4vw,0.95rem)]"
        style={{
          color: "var(--cover-ink-dim)",
          letterSpacing: "0.4em",
          textIndent: "0.4em",
        }}
      >
        阿瓦隆记录本
      </p>

      <p
        className="absolute bottom-[9vmin] text-[11px]"
        style={{ color: "rgba(139,150,164,0.75)", letterSpacing: "0.18em" }}
      >
        轻触任意位置开始
      </p>
    </button>
  );
}

/** Ten seats round a table, one of them the leader. The app's whole subject. */
function TableMark() {
  const seats = Array.from({ length: 10 }, (_, i) => {
    const angle = ((-90 + i * 36) * Math.PI) / 180;
    return {
      cx: 100 + 68 * Math.cos(angle),
      cy: 100 + 68 * Math.sin(angle),
      leader: i === 0,
    };
  });

  return (
    <svg
      viewBox="0 0 200 200"
      className="w-[26vmin] max-w-[132px]"
      role="img"
      aria-label="十个座位围成的圆桌"
    >
      <circle
        cx="100"
        cy="100"
        r="38"
        fill="none"
        stroke="var(--cover-ink)"
        strokeOpacity="0.22"
        strokeWidth="2"
      />
      {seats.map((seat, i) => (
        <circle
          key={i}
          cx={seat.cx}
          cy={seat.cy}
          r={seat.leader ? 10 : 7.5}
          fill={seat.leader ? "var(--cover-gold)" : "var(--cover-ink)"}
        />
      ))}
    </svg>
  );
}

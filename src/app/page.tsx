"use client";

import { useRouter } from "next/navigation";

/**
 * The cover.
 *
 * The artwork carries the wordmark, so the page adds nothing but the one line
 * telling you what to do — and that arrives a beat late, so the picture gets
 * a moment on its own before the interface asks anything of you.
 *
 * Two pieces of artwork, one per orientation. The portrait painting letterboxed
 * on a laptop looked like a phone screenshot someone had pasted onto a desktop;
 * a landscape crop of it would have cut the wordmark off the bottom. So the
 * landscape viewport gets a painting composed for that shape.
 *
 * The fit differs with them. Portrait is `contain`, because its wordmark runs
 * along the bottom edge and covering a shorter viewport would crop exactly
 * that — the blurred copy behind fills the letterbox so the fit reads as
 * atmosphere rather than as a black band. Landscape is `cover`: its wordmark
 * sits inboard of every edge, so it survives the crop and the picture can
 * reach the corners.
 */
/**
 * Orientation, not a width breakpoint: a phone turned sideways wants the
 * landscape painting for the same reason a laptop does, and a tall narrow
 * window on a desktop wants the portrait one.
 *
 * Kept identical to the Tailwind `landscape:` variant below — the <source>
 * decides which file loads, the class decides how it is fitted, and the two
 * must switch on the same condition or a viewport lands on one image fitted
 * for the other.
 */
const LANDSCAPE = "(orientation: landscape)";

export default function CoverPage() {
  const router = useRouter();

  return (
    <button
      onClick={() => router.push("/menu")}
      aria-label="开始"
      className="fixed inset-0 flex w-full items-center justify-center overflow-hidden bg-[#07090e]"
    >
      {/* An empty alt already hides this from assistive tech — the decorative
          copy exists only to fill whatever letterbox the fit leaves. */}
      <picture>
        <source media={LANDSCAPE} srcSet="/cover-wide.avif" type="image/avif" />
        <source media={LANDSCAPE} srcSet="/cover-wide.webp" type="image/webp" />
        <source srcSet="/cover.avif" type="image/avif" />
        <source srcSet="/cover.webp" type="image/webp" />
        <img
          src="/cover.webp"
          alt=""
          aria-hidden="true"
          className="absolute inset-0 h-full w-full scale-110 object-cover opacity-60 blur-2xl"
        />
      </picture>

      <picture>
        <source media={LANDSCAPE} srcSet="/cover-wide.avif" type="image/avif" />
        <source media={LANDSCAPE} srcSet="/cover-wide.webp" type="image/webp" />
        <source srcSet="/cover.avif" type="image/avif" />
        <source srcSet="/cover.webp" type="image/webp" />
        <img
          src="/cover.webp"
          alt="Avalor"
          fetchPriority="high"
          className="relative h-full w-full object-contain landscape:object-cover"
        />
      </picture>

      <span
        className="absolute bottom-[6vmin] text-[11px]"
        style={{
          color: "rgba(226,232,240,0.72)",
          letterSpacing: "0.22em",
          textIndent: "0.22em",
          textShadow: "0 1px 12px rgba(0,0,0,0.9)",
          animation: "cover-hint 1s ease-out 1.4s backwards",
        }}
      >
        轻触任意位置开始
      </span>
    </button>
  );
}

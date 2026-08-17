"use client";

import { useRouter } from "next/navigation";

/**
 * The cover.
 *
 * The artwork carries the wordmark, so the page adds nothing but the one line
 * telling you what to do — and that arrives a beat late, so the picture gets
 * a moment on its own before the interface asks anything of you.
 *
 * Fitted with `contain` rather than `cover`: the logo sits along the bottom
 * edge, and covering a shorter viewport would crop exactly that. The blurred
 * copy behind it fills whatever letterbox is left, so the fit is invisible
 * instead of being a black band.
 */
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
        <source srcSet="/cover.avif" type="image/avif" />
        <source srcSet="/cover.webp" type="image/webp" />
        <img
          src="/cover.webp"
          alt="Avalor"
          fetchPriority="high"
          className="relative h-full w-full object-contain"
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

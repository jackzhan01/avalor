"use client";

import Link from "next/link";
import { cn } from "@/lib/utils/cn";

/**
 * The round glyph button that opens and closes every page.
 *
 * A filled circle rather than a blue word: the header is the one strip that
 * looks the same on all twelve screens, so the way out of a screen should be
 * recognisable by shape before it is read. It also frees the header's middle
 * for whatever that page actually needs there — the round strip on the table,
 * nothing at all elsewhere.
 *
 * The circle is 32px but the tappable area is 44: the ::after box extends past
 * the circle without taking part in layout, so the target reaches the minimum
 * while the circle still sits flush with the content edge below it.
 */
export function RoundButton({
  glyph,
  label,
  href,
  onClick,
  className,
}: {
  glyph: string;
  /** Says where this goes, since the glyph alone cannot. */
  label: string;
  href?: string;
  onClick?: () => void;
  className?: string;
}) {
  const style = cn(
    "relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
    "bg-[color:var(--fill)] text-[18px] leading-none text-[color:var(--label-secondary)]",
    "after:absolute after:-inset-1.5 after:content-['']",
    "active:opacity-70",
    className,
  );

  return href ? (
    <Link href={href} aria-label={label} className={style}>
      <span aria-hidden>{glyph}</span>
    </Link>
  ) : (
    <button type="button" onClick={onClick} aria-label={label} className={style}>
      <span aria-hidden>{glyph}</span>
    </button>
  );
}

/**
 * Nav row on top, large title under it — the iOS arrangement, kept identical
 * everywhere so the eye never has to re-find the way back.
 *
 * The row is skipped entirely on pages that have neither a back button nor an
 * action, so the three tab screens do not carry an empty 32px band.
 */
export function PageHeader({
  back,
  title,
  subtitle,
  trailing,
}: {
  back?: { href?: string; onClick?: () => void; label: string };
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  trailing?: React.ReactNode;
}) {
  return (
    <header className="pt-safe pb-4 pt-3">
      {(back || trailing) && (
        <div className="flex min-h-[32px] items-center gap-2">
          {back && (
            <RoundButton
              glyph="‹"
              label={back.label}
              href={back.href}
              onClick={back.onClick}
            />
          )}
          <div className="min-w-0 flex-1" />
          {trailing}
        </div>
      )}
      {title && <h1 className="t-large-title mt-2">{title}</h1>}
      {subtitle && (
        <p className="t-subhead mt-1 text-[color:var(--label-secondary)]">
          {subtitle}
        </p>
      )}
    </header>
  );
}

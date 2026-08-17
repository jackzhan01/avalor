"use client";

import { cn } from "@/lib/utils/cn";

/**
 * Grouped inset list — the backbone of every screen.
 *
 * Using one list idiom everywhere is what keeps the app quiet: the user learns
 * "rounded card, rows, chevron means deeper" once and it holds throughout.
 */
export function ListGroup({
  header,
  footer,
  children,
  className,
}: {
  header?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("flex flex-col", className)}>
      {header && (
        <h2 className="t-footnote px-4 pb-1.5 uppercase tracking-[0.06em] text-[color:var(--label-secondary)]">
          {header}
        </h2>
      )}
      <div className="overflow-hidden rounded-[10px] bg-[color:var(--bg-elevated)]">
        {children}
      </div>
      {footer && (
        <p className="t-footnote px-4 pt-1.5 text-[color:var(--label-secondary)]">
          {footer}
        </p>
      )}
    </section>
  );
}

export function ListRow({
  label,
  detail,
  value,
  accessory = "none",
  leading,
  destructive,
  disabled,
  onClick,
  href,
  inset = 16,
}: {
  label: React.ReactNode;
  /** Secondary line under the label. */
  detail?: React.ReactNode;
  /** Right-aligned value, before the accessory. */
  value?: React.ReactNode;
  accessory?: "none" | "chevron" | "check";
  leading?: React.ReactNode;
  destructive?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  href?: string;
  /** Where the separator above this row starts. Match it to the content. */
  inset?: number;
}) {
  const interactive = Boolean(onClick || href);
  const content = (
    <>
      {leading && <span className="shrink-0">{leading}</span>}
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "t-body block truncate",
            destructive && "text-[color:var(--red)]",
          )}
        >
          {label}
        </span>
        {detail && (
          <span className="t-footnote mt-0.5 block text-[color:var(--label-secondary)]">
            {detail}
          </span>
        )}
      </span>
      {value !== undefined && value !== null && (
        <span className="t-body shrink-0 text-[color:var(--label-secondary)]">
          {value}
        </span>
      )}
      {accessory === "chevron" && (
        <span
          aria-hidden
          className="shrink-0 text-[17px] leading-none text-[color:var(--label-tertiary)]"
        >
          ›
        </span>
      )}
      {accessory === "check" && (
        <span aria-hidden className="shrink-0 text-[17px] leading-none text-[color:var(--blue)]">
          ✓
        </span>
      )}
    </>
  );

  const classes = cn(
    "list-row flex w-full items-center gap-3 px-4 text-left",
    // 44pt is the iOS minimum touch target, and this app is used one-handed.
    "min-h-[44px] py-2.5",
    interactive && "active:bg-[color:var(--fill)]",
    disabled && "opacity-40 pointer-events-none",
  );

  const style = { "--inset": `${inset}px` } as React.CSSProperties;

  if (href) {
    return (
      <a href={href} className={classes} style={style}>
        {content}
      </a>
    );
  }
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={classes} style={style}>
        {content}
      </button>
    );
  }
  return (
    <div className={classes} style={style}>
      {content}
    </div>
  );
}

/** Full-width tinted action row, e.g. a destructive button in its own group. */
export function ListAction({
  label,
  destructive,
  onClick,
  disabled,
}: {
  label: string;
  destructive?: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "t-body flex min-h-[44px] w-full items-center justify-center px-4",
        "active:bg-[color:var(--fill)] disabled:opacity-40",
        destructive ? "text-[color:var(--red)]" : "text-[color:var(--blue)]",
      )}
    >
      {label}
    </button>
  );
}

import { cn } from "@/lib/utils/cn";

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn("animate-pulse rounded-lg bg-surface-2", className)}
      aria-hidden
    />
  );
}

export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border px-6 py-10 text-center">
      <p className="text-sm font-medium text-fg-muted">{title}</p>
      {hint && <p className="text-[13px] text-fg-subtle">{hint}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/** Non-blocking advisory. Never used to prevent a save. */
export function WarningBanner({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-lg px-3 py-2 text-[13px]",
        "bg-warn-bg text-warn",
        className,
      )}
    >
      <span aria-hidden className="mt-px shrink-0">
        ⚠
      </span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function SectionTitle({
  children,
  action,
}: {
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-2 flex items-center justify-between gap-2">
      <h3 className="text-[13px] font-semibold uppercase tracking-wide text-fg-subtle">
        {children}
      </h3>
      {action}
    </div>
  );
}

export function Card({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-xl border border-border bg-surface p-3",
        className,
      )}
    >
      {children}
    </div>
  );
}

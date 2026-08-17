import { cn } from "@/lib/utils/cn";

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn("animate-pulse rounded-[10px] bg-[color:var(--fill)]", className)}
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
    <div className="flex flex-col items-center justify-center gap-1.5 px-6 py-12 text-center">
      <p className="t-callout font-medium text-[color:var(--label-secondary)]">
        {title}
      </p>
      {hint && (
        <p className="t-footnote text-[color:var(--label-tertiary)]">{hint}</p>
      )}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

/** Advisory only. Nothing in this app blocks a save. */
export function InlineWarning({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <p
      className={cn(
        "t-footnote rounded-[10px] bg-[color:var(--fill)] px-3 py-2 text-[color:var(--orange)]",
        className,
      )}
    >
      {children}
    </p>
  );
}

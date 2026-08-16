"use client";

import { cn } from "@/lib/utils/cn";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "md" | "lg";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-accent-fg active:brightness-95",
  secondary:
    "bg-surface-2 text-fg border border-border active:bg-surface-3",
  ghost: "text-fg-muted active:bg-surface-2",
  danger: "bg-danger text-white active:brightness-95",
};

const SIZES: Record<Size, string> = {
  // 44px is the accessibility floor for a touch target, and this app is used
  // one-handed at a table while talking.
  md: "min-h-[44px] px-4 text-[15px]",
  lg: "min-h-[52px] px-5 text-base",
};

export function Button({
  variant = "primary",
  size = "md",
  fullWidth,
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  fullWidth?: boolean;
}) {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-xl font-medium",
        "transition-[filter,background-color] disabled:opacity-40 disabled:pointer-events-none",
        VARIANTS[variant],
        SIZES[size],
        fullWidth && "w-full",
        className,
      )}
      {...props}
    />
  );
}

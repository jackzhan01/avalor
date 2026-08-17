"use client";

import { cn } from "@/lib/utils/cn";

type Variant = "filled" | "tinted" | "gray" | "plain" | "destructive";

const VARIANTS: Record<Variant, string> = {
  filled: "bg-[color:var(--blue)] text-white active:opacity-80",
  tinted:
    "bg-[color:var(--fill)] text-[color:var(--blue)] active:bg-[color:var(--fill-2)]",
  gray: "bg-[color:var(--fill)] text-[color:var(--label)] active:bg-[color:var(--fill-2)]",
  plain: "text-[color:var(--blue)] active:opacity-60",
  destructive: "bg-[color:var(--red)] text-white active:opacity-80",
};

export function Button({
  variant = "filled",
  size = "md",
  fullWidth,
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: "md" | "lg";
  fullWidth?: boolean;
}) {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-[12px] font-semibold",
        "transition-opacity disabled:pointer-events-none disabled:opacity-40",
        size === "lg"
          ? "min-h-[50px] px-5 text-[17px]"
          : "min-h-[44px] px-4 text-[17px]",
        VARIANTS[variant],
        fullWidth && "w-full",
        className,
      )}
      {...props}
    />
  );
}

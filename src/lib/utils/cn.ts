/** Tiny classnames join. Avoids pulling in clsx for what is four lines. */
export function cn(
  ...parts: Array<string | false | null | undefined>
): string {
  return parts.filter(Boolean).join(" ");
}

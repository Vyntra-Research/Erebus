import { cn } from "../lib/utils";

export function ErebusBrandMark({
  className,
  alt = "",
}: {
  readonly className?: string;
  readonly alt?: string;
}) {
  return (
    <span className={cn("inline-flex shrink-0 items-center justify-center", className)}>
      <img
        aria-hidden={alt.length === 0 || undefined}
        alt={alt}
        className="size-full object-contain dark:hidden"
        src="/erebus-glyph-dark.png"
      />
      <img
        aria-hidden={alt.length === 0 || undefined}
        alt={alt}
        className="hidden size-full object-contain dark:block"
        src="/erebus-glyph-light.png"
      />
    </span>
  );
}

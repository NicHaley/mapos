import { cn } from "@mapos/ui/lib/utils";

/**
 * Compact ring indicator for progress between 0 and 100. The ring uses
 * `currentColor`, so the caller controls the color via Tailwind text classes.
 */
function CircularProgress({
  percent,
  className,
  size = 16,
  strokeWidth = 2
}: {
  percent: number;
  className?: string;
  size?: number;
  strokeWidth?: number;
}): React.JSX.Element {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, percent));
  const offset = circumference - (clamped / 100) * circumference;
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorative ring; aria-hidden hides it from AT, percent is conveyed by surrounding label text.
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={cn("shrink-0", className)}
      aria-hidden
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        strokeWidth={strokeWidth}
        className="stroke-current opacity-25"
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        className="stroke-current transition-[stroke-dashoffset] duration-200"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}

export { CircularProgress };

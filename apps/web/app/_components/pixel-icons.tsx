import type { SVGProps } from "react";

// Pixelarticons (https://pixelarticons.com), MIT. Only the handful the landing
// page uses are vendored — the npm package is 877 icons and 1.7k files for the
// six below, and `pnpm add` currently fails repo-wide (see apps/dashboard's
// @electron/node-gyp git subdep). Adding another is copy-paste from
// pixelarticons/svg/<name>.svg; the path data here is unmodified.
//
// These are the marketing surface only. Icons drawn *inside* the app-window
// captures (agent-demo, meetup-demo) stay on Lucide so they keep matching the
// real MapOS UI in the screenshot behind them.

type IconProps = SVGProps<SVGSVGElement> & {
  /** Square size in px, mirroring react-icons so call sites read the same. */
  size?: number;
};

function PixelIcon({ children, size = 24, ...props }: IconProps) {
  return (
    // Every use sits next to its own text label, so these are decorative by
    // default; a caller can still pass aria-label to override.
    <svg
      aria-hidden="true"
      fill="currentColor"
      height={size}
      viewBox="0 0 24 24"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      {children}
    </svg>
  );
}

/** pixelarticons/file-text */
export function PixelFileText(props: IconProps) {
  return (
    <PixelIcon {...props}>
      <path d="M6 4H4v16h2zm10-2H6v2h10zm4 4h-2v14h2zm-2 14H6v2h12zM16 4h2v2h-2zm-4 0h2v6h-2z" />
      <path d="M12 8h6v2h-6zm-4 8h8v2H8zm0-4h8v2H8zm0-4h2v2H8z" />
    </PixelIcon>
  );
}

/** pixelarticons/server */
export function PixelServer(props: IconProps) {
  return (
    <PixelIcon {...props}>
      <path d="M6 7h4v2H6zm0 8h4v2H6zM2 5h2v14H2zm18 0h2v14h-2zM4 19h16v2H4zM4 3h16v2H4zm0 8h16v2H4z" />
    </PixelIcon>
  );
}

/** pixelarticons/cellular-signal-0 — no bars, i.e. works with nothing connected */
export function PixelSignalOff(props: IconProps) {
  return (
    <PixelIcon {...props}>
      <path d="M4 14h2v2H4zm7-4h2v2h-2zm7-6h2v2h-2zM2 16h2v2H2zm7-4h2v6H9zm7-6h2v12h-2zM6 14h2v4H6zm7-4h2v8h-2zm7-6h2v14h-2zM2 18h6v2H2zm7 0h6v2H9zm7 0h6v2h-6z" />
    </PixelIcon>
  );
}

/** pixelarticons/check */
export function PixelCheck(props: IconProps) {
  return (
    <PixelIcon {...props}>
      <path d="M10 18H8v-2h2v2Zm-2-2H6v-2h2v2Zm4-2v2h-2v-2h2Zm-6 0H4v-2h2v2Zm8 0h-2v-2h2v2Zm2-2h-2v-2h2v2Zm2-2h-2V8h2v2Zm2-2h-2V6h2v2Z" />
    </PixelIcon>
  );
}

/** pixelarticons/copy */
export function PixelCopy(props: IconProps) {
  return (
    <PixelIcon {...props}>
      <path d="M8 6h12v2H8zM4 2h12v2H4zm2 6h2v12H6zM2 4h2v12H2zm6 16h12v2H8zM20 8h2v12h-2zm-4-4h2v2h-2zM4 16h2v2H4z" />
    </PixelIcon>
  );
}

/** pixelarticons/play */
export function PixelPlay(props: IconProps) {
  return (
    <PixelIcon {...props}>
      <path d="M15 11h-2V9h2zm0 4h-2v-2h2zm-2 2h-2v-2h2zm0-8h-2V7h2zm-2-2H9V5h2zM9 21H7V3h2zm6-8h2v-2h-2zm-6 4h2v2H9z" />
    </PixelIcon>
  );
}

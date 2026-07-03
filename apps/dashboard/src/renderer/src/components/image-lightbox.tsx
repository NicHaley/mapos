import { cn } from "@mapos/ui/lib/utils";
import { XIcon } from "lucide-react";
import { Fragment, useEffect, useState } from "react";
import { createPortal } from "react-dom";

// The lightbox overlays the app's draggable titlebar strip; without no-drag,
// Electron's drag hit-testing swallows clicks on anything rendered there.
const noDrag = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

export type LightboxData = {
  /** Full-size display URL (protocol URL for vault files, https for remote). */
  src: string;
  artist?: string;
  license?: string;
  licenseUrl?: string;
  /** Source page (e.g. the Wikimedia Commons file page). */
  pageUrl?: string;
  pageLabel?: string;
};

/**
 * Full-screen image viewer, Wikipedia Media Viewer-style: the image large in
 * the center with the attribution/credit line rendered beneath it. This is
 * where Commons attribution lives — the card heroes stay clean.
 */
export function ImageLightbox({
  image,
  onClose
}: {
  image: LightboxData;
  onClose: () => void;
}): React.JSX.Element {
  // Natural dimensions, used to cap the display size at the image's true
  // resolution (÷ devicePixelRatio) so small images aren't blown up blurry.
  // Callers key this component by src, so a new image always remounts fresh.
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        // Capture phase + stopPropagation so the place card's own window-level
        // Escape handler doesn't also close the card underneath the lightbox.
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const credit: React.ReactNode[] = [];
  if (image.artist) credit.push(<span key="artist">© {image.artist}</span>);
  if (image.license) {
    credit.push(
      image.licenseUrl ? (
        <a
          key="license"
          href={image.licenseUrl}
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-2 hover:text-white transition-colors"
        >
          {image.license}
        </a>
      ) : (
        <span key="license">{image.license}</span>
      )
    );
  }
  if (image.pageUrl) {
    credit.push(
      <a
        key="page"
        href={image.pageUrl}
        target="_blank"
        rel="noreferrer"
        className="underline underline-offset-2 hover:text-white transition-colors"
      >
        {image.pageLabel ?? "Source"}
      </a>
    );
  }

  const dpr = window.devicePixelRatio || 1;

  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col bg-black/85 backdrop-blur-sm" style={noDrag}>
      {/* Backdrop click-to-close layer under the content. */}
      <button
        type="button"
        onClick={onClose}
        aria-label="Close image"
        className="absolute inset-0 cursor-default"
        style={noDrag}
      />
      <button
        type="button"
        onClick={onClose}
        aria-label="Close image"
        className="absolute top-3 right-3 z-10 rounded-full bg-black/50 p-2 text-white/80 hover:text-white transition-colors"
        style={noDrag}
      >
        <XIcon className="size-4" />
      </button>
      <div className="relative flex-1 min-h-0 flex items-center justify-center p-10 pointer-events-none">
        <img
          src={image.src}
          alt=""
          draggable={false}
          onLoad={(e) =>
            setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })
          }
          className={cn(
            "max-h-full max-w-full rounded-md object-contain shadow-2xl pointer-events-auto",
            // Hidden until onLoad reports natural dimensions — otherwise the image
            // paints uncapped for a frame and visibly snaps down to the DPR cap.
            !natural && "invisible"
          )}
          style={
            natural
              ? {
                  maxWidth: `min(100%, ${Math.round(natural.w / dpr)}px)`,
                  maxHeight: `min(100%, ${Math.round(natural.h / dpr)}px)`
                }
              : undefined
          }
        />
      </div>
      {credit.length > 0 && (
        <div className="relative shrink-0 px-6 pb-5 text-center text-xs text-white/70">
          {credit.map((part, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static ordered fragments
            <Fragment key={i}>
              {i > 0 && " · "}
              {part}
            </Fragment>
          ))}
        </div>
      )}
    </div>,
    document.body
  );
}

import { useEffect, useState } from "react";

export function useFullscreen(): boolean {
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    window.api.window.isFullscreen().then((value) => {
      if (!cancelled) setIsFullscreen(value);
    });
    const off = window.api.window.onFullscreenChange(setIsFullscreen);
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  return isFullscreen;
}

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AsciiStarfield } from "./ascii-starfield";
import { AsciiSun } from "./ascii-sun";
import { MapOSLogo } from "./mapos-logo";

export function Landing() {
  const [dark, setDark] = useState(true);
  const sunScene = useMemo(
    () => ({ disableStars: true, flareLength: 1.0 }),
    [],
  );
  const sceneRef = useRef<HTMLDivElement | null>(null);
  const [sceneBottom, setSceneBottom] = useState<number | null>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  }, [dark]);

  useEffect(() => {
    const el = sceneRef.current;
    if (!el) return;
    const update = () => {
      setSceneBottom(el.getBoundingClientRect().bottom);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener("resize", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
    };
  }, []);

  return (
    <>
      <div
        className="page-bg"
        aria-hidden="true"
        style={
          sceneBottom != null ? { height: `${sceneBottom}px` } : undefined
        }
      >
        <AsciiStarfield dark={dark} />
      </div>
      <div className="page">
        <header className="topbar">
          <div className="brand">
            <MapOSLogo dark={dark} />
            <span className="brand-name">MapOS</span>
          </div>
          <button
            type="button"
            className="theme-toggle"
            onClick={() => setDark((d) => !d)}
            aria-label="Toggle theme"
          >
            {dark ? "☀" : "☾"}
          </button>
        </header>

        <main className="stage">
          <div className="ascii-scene" ref={sceneRef}>
            <AsciiSun dark={dark} scene={sunScene} />
          </div>
          <section className="copy">
            <h1 className="tagline">Markdown maps for AI.</h1>
            <p className="blurb">
              A plaintext map format your agents can actually read, write, and
              reason about.
            </p>
            <div className="cta-row">
              <a className="btn" href="#download">
                <svg
                  viewBox="0 0 24 24"
                  width="14"
                  height="14"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path d="M16.365 1.43c0 1.14-.42 2.21-1.14 3.04-.78.92-2.05 1.62-3.27 1.53-.15-1.1.41-2.27 1.16-3.06.83-.87 2.22-1.51 3.25-1.51zM20.5 17.36c-.56 1.27-.83 1.84-1.55 2.97-1.01 1.59-2.43 3.57-4.18 3.58-1.55.02-1.95-1.01-4.06-1-2.11.01-2.55 1.02-4.1 1-1.75-.02-3.1-1.81-4.11-3.4C-.27 17.04-.74 11.66 1.86 8.62c1.18-1.4 3.05-2.29 4.79-2.29 1.78 0 2.9 1 4.36 1 1.42 0 2.28-1 4.34-1 1.55 0 3.2.85 4.37 2.31-3.84 2.11-3.21 7.59 0 8.72z" />
                </svg>
                Download for macOS
              </a>
              <span className="version">v0.1.4 · Apple Silicon · 4.2 MB</span>
            </div>
          </section>
        </main>

        <footer className="footnote">
          <span>© 2026 MapOS</span>
          <span className="dot">·</span>
          <span>made for cartographers and language models</span>
        </footer>
      </div>
    </>
  );
}

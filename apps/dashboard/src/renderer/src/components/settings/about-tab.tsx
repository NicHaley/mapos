import { Button, buttonVariants } from "@mapos/ui/components/button";
import { GlobeIcon, MailIcon, MegaphoneIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import maposLogo from "../../assets/mapos.svg";

const LINKS: { label: string; href: string; icon: React.ElementType }[] = [
  {
    label: "Feedback",
    href: "https://mapos.userjot.com/?cursor=1&order=top&limit=10",
    icon: MegaphoneIcon
  },
  { label: "Website", href: "https://mapos.md", icon: GlobeIcon },
  { label: "Email", href: "mailto:hello@mapos.md", icon: MailIcon }
];

// Open-source projects and data MapOS is built on. OpenStreetMap is listed
// first as its data underpins the map, geocoding, and routing.
const ACKNOWLEDGEMENTS: { label: string; href: string }[] = [
  { label: "OpenStreetMap", href: "https://www.openstreetmap.org/copyright" },
  { label: "MapLibre", href: "https://maplibre.org" },
  { label: "Protomaps", href: "https://protomaps.com" },
  { label: "Photon", href: "https://photon.komoot.io" },
  { label: "Valhalla", href: "https://github.com/valhalla/valhalla" },
  { label: "Geofabrik", href: "https://www.geofabrik.de" },
  { label: "Natural Earth", href: "https://www.naturalearthdata.com" },
  { label: "Wikidata", href: "https://www.wikidata.org" }
];

type CheckState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "up-to-date" }
  | { kind: "available"; version: string }
  | { kind: "error"; message: string };

export function AboutTab() {
  const [version, setVersion] = useState<string | null>(null);
  const [check, setCheck] = useState<CheckState>({ kind: "idle" });

  useEffect(() => {
    void window.api.app.getVersion().then(setVersion);
  }, []);

  const handleCheck = useCallback(async () => {
    setCheck({ kind: "checking" });
    const r = await window.api.updater.check();
    if (!r.ok) {
      setCheck({ kind: "error", message: r.error });
    } else if (r.available) {
      setCheck({ kind: "available", version: r.latest });
    } else {
      setCheck({ kind: "up-to-date" });
    }
  }, []);

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-1 flex-col items-center justify-center gap-6 text-center">
        <div className="flex size-16 items-center justify-center rounded-xl border border-border bg-input/30">
          <img src={maposLogo} alt="" aria-hidden className="h-9 w-auto" />
        </div>

        <div className="flex flex-col items-center gap-1">
          <h2 className="text-xl font-semibold tracking-tight">MapOS</h2>
          <p className="font-mono text-sm text-muted-foreground">
            {version ? `Version ${version}` : "Loading version…"}
          </p>
        </div>

        <div className="flex flex-col items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleCheck()}
            disabled={check.kind === "checking"}
          >
            {check.kind === "checking" ? "Checking…" : "Check for updates"}
          </Button>
          {check.kind === "up-to-date" && (
            <p className="text-xs text-muted-foreground">You're on the latest version.</p>
          )}
          {check.kind === "available" && (
            <p className="text-xs text-foreground">
              Version {check.version} is available — it will download in the background.
            </p>
          )}
          {check.kind === "error" && (
            <p className="text-xs text-destructive">Couldn't check for updates: {check.message}</p>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-center gap-1.5 pt-6">
        {LINKS.map(({ label, href, icon: Icon }) => (
          <a
            key={label}
            href={href}
            target="_blank"
            rel="noreferrer"
            className={buttonVariants({ variant: "ghost", size: "sm" })}
          >
            <Icon />
            <span>{label}</span>
          </a>
        ))}
      </div>

      <div className="flex flex-col items-center gap-2 pt-6 text-center">
        <p className="text-xs text-muted-foreground">
          Built with{" "}
          {ACKNOWLEDGEMENTS.map(({ label, href }, i) => (
            <span key={label}>
              {i > 0 && ", "}
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                className="underline-offset-2 hover:text-foreground hover:underline"
              >
                {label}
              </a>
            </span>
          ))}
          , and other open-source software.
        </p>
        <p className="text-xs text-muted-foreground">© {new Date().getFullYear()} MapOS</p>
      </div>
    </div>
  );
}

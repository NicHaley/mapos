import { getCloudflareContext } from "@opennextjs/cloudflare";
import { notFound } from "next/navigation";

// Private download-stats dashboard, gated by ?key=<STATS_KEY>. Wrong or missing
// key 404s so the page doesn't advertise its existence.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "MapOS — Download stats",
  robots: { index: false, follow: false }
};

const WINDOW_DAYS = 60;
const TABLE_DAYS = 14;

// Palette validated for CVD separation and 3:1 contrast on the card surface.
const SERIES = [
  { platform: "mac", label: "macOS", color: "#3987e5" },
  { platform: "other", label: "Other", color: "#199e70" }
] as const;

type Row = { day: string; platform: string; count: number };

type DayBucket = { day: string; mac: number; other: number; bot: number };

export default async function StatsPage({
  searchParams
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const sp = await searchParams;
  const key = typeof sp.key === "string" ? sp.key : undefined;
  const { env } = getCloudflareContext();
  if (!env.STATS_KEY || key !== env.STATS_KEY) notFound();

  if (!env.STATS_DB) {
    return (
      <Shell>
        <p className="text-neutral-400">
          Stats database is not bound in this environment. Restart the dev server (or deploy) to
          pick up the STATS_DB binding.
        </p>
      </Shell>
    );
  }

  const [windowRes, totalsRes] = await Promise.all([
    env.STATS_DB.prepare("SELECT day, platform, count FROM downloads WHERE day >= date('now', ?)")
      .bind(`-${WINDOW_DAYS - 1} days`)
      .all<Row>(),
    env.STATS_DB.prepare(
      "SELECT platform, SUM(count) AS count FROM downloads GROUP BY platform"
    ).all<{ platform: string; count: number }>()
  ]);

  const byDay = new Map<string, DayBucket>();
  for (const r of windowRes.results) {
    const bucket = byDay.get(r.day) ?? { day: r.day, mac: 0, other: 0, bot: 0 };
    if (r.platform === "mac" || r.platform === "other" || r.platform === "bot") {
      bucket[r.platform] += r.count;
    }
    byDay.set(r.day, bucket);
  }
  const today = Date.now();
  const days: DayBucket[] = Array.from({ length: WINDOW_DAYS }, (_, i) => {
    const day = new Date(today - (WINDOW_DAYS - 1 - i) * 86_400_000).toISOString().slice(0, 10);
    return byDay.get(day) ?? { day, mac: 0, other: 0, bot: 0 };
  });

  const human = (b: DayBucket) => b.mac + b.other;
  const sum = (list: DayBucket[]) => list.reduce((acc, b) => acc + human(b), 0);
  const totals = Object.fromEntries(totalsRes.results.map((r) => [r.platform, r.count]));
  const allTime = (totals.mac ?? 0) + (totals.other ?? 0);

  return (
    <Shell>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="All-time" value={allTime} />
        <StatTile label="Last 7 days" value={sum(days.slice(-7))} />
        <StatTile label="Today" value={human(days[days.length - 1])} />
        <StatTile label="Bots (all-time)" value={totals.bot ?? 0} muted />
      </div>

      <section className="rounded-xl border border-white/10 bg-[#161616] p-5">
        <div className="mb-4 flex items-baseline justify-between gap-4">
          <h2 className="m-0 text-sm font-medium text-neutral-50">
            Daily downloads · last {WINDOW_DAYS} days
          </h2>
          <div className="flex items-center gap-4">
            {SERIES.map((s) => (
              <span key={s.platform} className="flex items-center gap-1.5 text-xs text-neutral-400">
                <span
                  className="inline-block h-2.5 w-2.5 rounded-sm"
                  style={{ backgroundColor: s.color }}
                />
                {s.label}
              </span>
            ))}
          </div>
        </div>
        <Chart days={days} />
        <p className="mt-3 mb-0 text-xs text-neutral-500">
          Bot and crawler hits are excluded from the chart and totals above.
        </p>
      </section>

      <section className="rounded-xl border border-white/10 bg-[#161616] p-5">
        <h2 className="m-0 mb-3 text-sm font-medium text-neutral-50">Last {TABLE_DAYS} days</h2>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="text-left text-xs text-neutral-500">
              <th className="py-1.5 pr-4 font-normal">Day</th>
              <th className="py-1.5 pr-4 text-right font-normal">macOS</th>
              <th className="py-1.5 pr-4 text-right font-normal">Other</th>
              <th className="py-1.5 pr-4 text-right font-normal">Bots</th>
              <th className="py-1.5 text-right font-normal">Total</th>
            </tr>
          </thead>
          <tbody className="font-[family-name:var(--font-server-mono)] text-[13px]">
            {days
              .slice(-TABLE_DAYS)
              .reverse()
              .map((b) => (
                <tr key={b.day} className="border-t border-white/5 text-neutral-300">
                  <td className="py-1.5 pr-4">{b.day}</td>
                  <td className="py-1.5 pr-4 text-right">{b.mac}</td>
                  <td className="py-1.5 pr-4 text-right">{b.other}</td>
                  <td className="py-1.5 pr-4 text-right text-neutral-500">{b.bot}</td>
                  <td className="py-1.5 text-right text-neutral-50">{human(b)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </section>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-screen max-w-3xl flex-col gap-4 px-5 py-14">
      <header className="mb-2">
        <h1 className="m-0 font-[family-name:var(--font-handjet)] text-3xl font-normal text-neutral-50">
          Download stats
        </h1>
        <p className="m-0 mt-1 font-[family-name:var(--font-server-mono)] text-xs text-neutral-500">
          mapos.app/download · counted server-side, nothing identifying stored
        </p>
      </header>
      {children}
    </div>
  );
}

function StatTile({
  label,
  value,
  muted = false
}: { label: string; value: number; muted?: boolean }) {
  return (
    <div className="rounded-xl border border-white/10 bg-[#161616] p-4">
      <div className="text-xs text-neutral-500">{label}</div>
      <div
        className={`mt-1 font-[family-name:var(--font-server-mono)] text-2xl ${muted ? "text-neutral-500" : "text-neutral-50"}`}
      >
        {value.toLocaleString("en-US")}
      </div>
    </div>
  );
}

// Stacked SVG bars: mac anchored to the baseline, other above it, a 2px
// surface gap between segments, and only the data end (top) rounded.
function Chart({ days }: { days: DayBucket[] }) {
  const width = 720;
  const height = 180;
  const padLeft = 34;
  const padBottom = 18;
  const plotW = width - padLeft;
  const plotH = height - padBottom;
  const gap = 2;
  const barW = plotW / days.length - gap;

  const max = Math.max(1, ...days.map((b) => b.mac + b.other));
  const niceMax = niceCeil(max);
  const yFor = (v: number) => plotH - (v / niceMax) * plotH;
  // Counts are integers — skip the midpoint gridline when it wouldn't be one.
  const ticks = Number.isInteger(niceMax / 2) ? [niceMax / 2, niceMax] : [niceMax];

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="block h-auto w-full"
      role="img"
      aria-label={`Daily downloads for the last ${days.length} days`}
    >
      <line x1={padLeft} y1={plotH} x2={width} y2={plotH} stroke="#383835" strokeWidth="1" />
      {ticks.map((t) => (
        <g key={t}>
          <line
            x1={padLeft}
            y1={yFor(t)}
            x2={width}
            y2={yFor(t)}
            stroke="#2c2c2a"
            strokeWidth="1"
          />
          <text x={padLeft - 6} y={yFor(t) + 3.5} textAnchor="end" fontSize="10" fill="#898781">
            {t}
          </text>
        </g>
      ))}
      {days.map((b, i) => {
        const x = padLeft + i * (barW + gap);
        const macH = (b.mac / niceMax) * plotH;
        const otherH = (b.other / niceMax) * plotH;
        const otherY = plotH - macH - (macH > 0 && otherH > 0 ? gap : 0) - otherH;
        return (
          <g key={b.day}>
            <title>{`${b.day} — ${b.mac} macOS, ${b.other} other`}</title>
            {/* invisible full-height hit target so hover works on short bars */}
            <rect x={x} y={0} width={barW + gap} height={plotH} fill="transparent" />
            {b.mac > 0 &&
              (b.other > 0 ? (
                <rect x={x} y={plotH - macH} width={barW} height={macH} fill={SERIES[0].color} />
              ) : (
                <path d={topRounded(x, plotH - macH, barW, macH)} fill={SERIES[0].color} />
              ))}
            {b.other > 0 && <path d={topRounded(x, otherY, barW, otherH)} fill={SERIES[1].color} />}
          </g>
        );
      })}
      {[0, Math.floor(days.length / 2), days.length - 1].map((i) => (
        <text
          key={days[i].day}
          x={padLeft + i * (barW + gap) + barW / 2}
          y={height - 5}
          textAnchor={i === 0 ? "start" : i === days.length - 1 ? "end" : "middle"}
          fontSize="10"
          fill="#898781"
        >
          {days[i].day.slice(5)}
        </text>
      ))}
    </svg>
  );
}

// Rect path with only the top corners rounded, so the data end is rounded
// while the baseline end stays square.
function topRounded(x: number, y: number, w: number, h: number, r = 2.5) {
  const rr = Math.min(r, w / 2, h);
  return [
    `M${x},${y + h}`,
    `v${-(h - rr)}`,
    `q0,${-rr} ${rr},${-rr}`,
    `h${w - 2 * rr}`,
    `q${rr},0 ${rr},${rr}`,
    `v${h - rr}`,
    "z"
  ].join(" ");
}

/** 7 -> 8, 23 -> 25, 180 -> 200: smallest of {1,2,2.5,5,10}×10^n >= v. */
function niceCeil(v: number) {
  const pow = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (m * pow >= v) return m * pow;
  }
  return 10 * pow;
}

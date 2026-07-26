import { Fragment } from "react";

// The full MCP surface as two counter-scrolling belts. Every name here is a
// tool `buildMaposCustomTools` actually registers, split by what it touches:
// the map and the index above, the vault and region packs below. `web_search`
// is left out — it's the one tool that only exists when a search key is
// configured, so the count stays true for every install.
const MAP_TOOLS = [
  "geocode_search",
  "reverse_geocode",
  "find_near",
  "query_spatial_index",
  "spatial_sql",
  "geo_compute",
  "compute_bbox",
  "query_within_polygon",
  "get_directions",
  "get_isochrone",
  "get_matrix",
  "present_features",
  "present_directions",
  "pan_to",
  "get_viewport",
  "get_active_file",
  "get_open_tabs",
  "get_current_location",
];

const VAULT_TOOLS = [
  "read_vault_file",
  "list_vault_files",
  "search_vault_files",
  "write_vault_file",
  "write_frontmatter_property",
  "write_frontmatter_properties",
  "write_place_body",
  "save_features_to_vault",
  "rename_vault_file",
  "delete_vault_file",
  "open_file",
  "list_region_packs",
  "download_region_pack",
  "cancel_region_download",
  "delete_region_pack",
  "index_file",
  "rebuild_index",
];

// One accent per belt, so the eye has something to catch without the row
// turning into a highlight reel.
const ACCENTED = new Set(["spatial_sql", "save_features_to_vault"]);

const TOOL_COUNT = MAP_TOOLS.length + VAULT_TOOLS.length;

// Belts run edge to edge, so both ends dissolve into the section rather than
// stopping at a hard crop.
const EDGE_FADE =
  "linear-gradient(to right, transparent 0%, #000 15%, #000 85%, transparent 100%)";

type BeltProps = {
  tools: string[];
  /** Tailwind arbitrary animation naming one of the belt-* keyframes. */
  animation: string;
};

function Belt({ tools, animation }: BeltProps) {
  return (
    <div
      className="flex w-full overflow-hidden"
      style={{ maskImage: EDGE_FADE, WebkitMaskImage: EDGE_FADE }}
    >
      {/* Two identical copies. Each renders a trailing separator and a trailing
          gap, so every gap in the track is equal and translating exactly -50%
          lands copy 2 where copy 1 started. shrink-0 is load-bearing: as a flex
          item the track would otherwise be shrunk to the clip's width, making
          -50% shorter than a copy and jumping on every loop. */}
      <div
        className={`flex w-max shrink-0 ${animation} motion-reduce:animate-none`}
      >
        {[0, 1].map((copy) => (
          <div
            aria-hidden={copy === 1}
            className="flex shrink-0 items-center gap-5.5 pr-5.5 font-[family-name:var(--font-server-mono)] text-[13px] leading-4"
            key={copy}
          >
            {tools.map((tool) => (
              <Fragment key={tool}>
                <span
                  className={`shrink-0 ${ACCENTED.has(tool) ? "text-[#7A97FF]" : "text-neutral-300"}`}
                >
                  [ {tool} ]
                </span>
                <span aria-hidden="true" className="shrink-0 text-neutral-700">
                  ·
                </span>
              </Fragment>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export function ToolBelt() {
  return (
    <div className="flex flex-col items-center gap-5.5 py-3">
      <Belt
        animation="animate-[belt-left_112s_linear_infinite]"
        tools={MAP_TOOLS}
      />
      {/* The belts are full-bleed; the caption is not, so it keeps the page's
          gutters and wraps rather than running off the edge on narrow screens. */}
      <span className="max-w-full px-[clamp(20px,4vw,56px)] text-center font-[family-name:var(--font-server-mono)] text-[11px] leading-4.5 tracking-[0.28em] text-neutral-500">
        {TOOL_COUNT} TOOLS · LOCAL MCP SEVER • BYO AGENT
      </span>
      <Belt
        animation="animate-[belt-right_123s_linear_infinite]"
        tools={VAULT_TOOLS}
      />
    </div>
  );
}

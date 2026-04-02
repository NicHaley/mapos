import type { ManifestRegion } from "@renderer/hooks/use-map-style";
import { TOP_BAR_HEIGHT_PX } from "@renderer/lib/layout";

type Props = {
  regions: ManifestRegion[];
  selectedRegionId: string | null;
  onSelect: (id: string | null) => void;
};

export function RegionPicker({ regions, selectedRegionId, onSelect }: Props) {
  if (regions.length === 0) return null;

  const selected = regions.find((r) => r.id === selectedRegionId);

  return (
    <div
      style={{
        position: "absolute",
        /* Below fixed top bar (z-30); map layer is z-0 so this cannot stack above the bar. */
        top: TOP_BAR_HEIGHT_PX + 10,
        right: 10,
        zIndex: 10,
        background: "rgba(255,255,255,0.92)",
        backdropFilter: "blur(4px)",
        borderRadius: 6,
        boxShadow: "0 1px 4px rgba(0,0,0,0.18)",
        padding: "4px 6px",
        display: "flex",
        alignItems: "center",
        gap: 6,
        fontSize: 12,
        color: "#1a1a1a"
      }}
    >
      <span style={{ fontWeight: 500, opacity: 0.6, userSelect: "none" }}>Tiles</span>
      <select
        value={selectedRegionId ?? ""}
        onChange={(e) => onSelect(e.target.value || null)}
        style={{
          fontSize: 12,
          border: "none",
          background: "transparent",
          cursor: "pointer",
          outline: "none",
          maxWidth: 180
        }}
      >
        <option value="">Default (Protomaps API)</option>
        {regions.map((r) => (
          <option key={r.id} value={r.id}>
            {r.name}
            {r.parent ? ` (${r.parent.split("/").pop()})` : ""}
          </option>
        ))}
      </select>
      {selected && (
        <span style={{ opacity: 0.45, fontSize: 11 }}>
          {(selected.size_bytes / 1024 ** 3).toFixed(1)} GB
        </span>
      )}
    </div>
  );
}

import { RegionPicker } from "./region-picker";

export function OfflineTab() {
  return (
    <div className="flex h-full flex-col gap-4">
      <div>
        <h2 className="text-base font-medium">Offline regions</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Download a region to use the map, search, and routing without a connection.
        </p>
      </div>
      <RegionPicker layout="stacked" />
    </div>
  );
}

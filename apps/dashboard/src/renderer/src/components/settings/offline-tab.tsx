import { PageHeader } from "./page-header";
import { RegionPicker } from "./region-picker";

export function OfflineTab() {
  return (
    <div className="flex h-full flex-col gap-6">
      <PageHeader
        title="Regions"
        description="Download a region to use the map, search, and routing without a connection."
      />
      <RegionPicker />
    </div>
  );
}

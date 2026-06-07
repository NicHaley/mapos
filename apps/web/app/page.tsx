import { Landing } from "./_components/landing";
import { formatBytes, getLatestRelease } from "./_lib/latest-release";

export default async function Home() {
  const release = await getLatestRelease();
  return (
    <Landing
      version={release?.version ?? null}
      sizeLabel={release?.sizeBytes != null ? formatBytes(release.sizeBytes) : null}
    />
  );
}

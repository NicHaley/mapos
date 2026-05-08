import { useCallback, useEffect, useState } from "react";
import type { DetectionState } from "./types";

const POLL_INTERVAL_MS = 2000;

export function useOllamaDetection(baseUrl: string): {
  detection: DetectionState;
  installed: string[];
  refresh: () => Promise<void>;
} {
  const [detection, setDetection] = useState<DetectionState>("checking");
  const [installed, setInstalled] = useState<string[]>([]);

  const refresh = useCallback(async () => {
    const detected = await window.api.aiConfig.ollamaDetect(baseUrl);
    setDetection(detected.running ? "running" : "stopped");
    if (detected.running) {
      const list = await window.api.aiConfig.ollamaListInstalled(baseUrl);
      setInstalled(list);
    } else {
      setInstalled([]);
    }
  }, [baseUrl]);

  useEffect(() => {
    void refresh();
    // Keep retrying while not running so users see it come online without manual refresh.
    const id = window.setInterval(() => {
      if (detection !== "running") void refresh();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [refresh, detection]);

  return { detection, installed, refresh };
}

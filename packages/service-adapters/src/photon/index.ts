import { forward, reverse } from "./geocoding";

export const photonAdapter = {
  id: "photon" as const,
  geocoding: { forward, reverse }
};

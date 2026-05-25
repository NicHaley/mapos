import type { Adapter } from "../types";
import { forward, reverse } from "./geocoding";

export const photonAdapter: Adapter = {
  id: "photon",
  geocoding: { forward, reverse }
};

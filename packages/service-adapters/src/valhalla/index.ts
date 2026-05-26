import type { Adapter } from "../types";
import { contours } from "./isochrone";
import { directions, matrix } from "./routing";

export const valhallaAdapter: Adapter = {
  id: "valhalla",
  routing: { directions, matrix },
  isochrones: { contours }
};

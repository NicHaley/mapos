import { contours } from "./isochrone";
import { directions, matrix } from "./routing";

export const valhallaAdapter = {
  id: "valhalla" as const,
  routing: { directions, matrix },
  isochrones: { contours }
};

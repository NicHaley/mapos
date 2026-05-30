import { contours } from "./isochrone";
import { directions, matrix } from "./routing";

export const valhallaAdapter = {
  id: "valhalla" as const,
  routing: { directions, matrix },
  isochrones: { contours }
};

// Pure request-builders + response-parsers + schemas, reused by the dashboard's
// in-process (local pack) adapter so online and offline Valhalla share one mapping.
export {
  buildRouteRequestBody,
  parseRouteResponse,
  ValhallaRouteResponseSchema,
  buildMatrixRequestBody,
  parseMatrixResponse,
  ValhallaMatrixResponseSchema
} from "./routing";
export type { ValhallaRouteResponse, ValhallaMatrixResponse } from "./routing";
export {
  buildIsochroneRequestBody,
  parseIsochroneResponse,
  ValhallaIsochroneResponseSchema
} from "./isochrone";
export type { ValhallaIsochroneResponse } from "./isochrone";

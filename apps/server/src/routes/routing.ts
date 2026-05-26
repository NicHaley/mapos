import {
  MatrixSchema,
  RouteDirectionsRequestSchema,
  RouteMatrixRequestSchema,
  RouteSchema
} from "@mapos/contracts";
import { valhallaAdapter } from "@mapos/service-adapters";
import type { Hono } from "hono";
import { loadEnv } from "../env";
import { handleContractPost } from "../route-helpers";

export function registerRouting(app: Hono): void {
  app.post("/v1/routing/directions", (c) =>
    handleContractPost(c, RouteDirectionsRequestSchema, RouteSchema, (req, signal) =>
      valhallaAdapter.routing.directions(req, { url: loadEnv(c.env).VALHALLA_URL }, { signal })
    )
  );

  app.post("/v1/routing/matrix", (c) =>
    handleContractPost(c, RouteMatrixRequestSchema, MatrixSchema, (req, signal) =>
      valhallaAdapter.routing.matrix(req, { url: loadEnv(c.env).VALHALLA_URL }, { signal })
    )
  );
}

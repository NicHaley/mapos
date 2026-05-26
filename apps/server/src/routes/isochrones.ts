import { IsochroneRequestSchema, IsochroneSchema } from "@mapos/contracts";
import { valhallaAdapter } from "@mapos/service-adapters";
import type { Hono } from "hono";
import { loadEnv } from "../env";
import { handleContractPost } from "../route-helpers";

export function registerIsochrones(app: Hono): void {
  app.post("/v1/isochrones", (c) =>
    handleContractPost(c, IsochroneRequestSchema, IsochroneSchema, (req, signal) =>
      valhallaAdapter.isochrones.contours(req, { url: loadEnv(c.env).VALHALLA_URL }, { signal })
    )
  );
}

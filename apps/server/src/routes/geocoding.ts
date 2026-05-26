import {
  GeocodeForwardRequestSchema,
  GeocodeResultSchema,
  GeocodeReverseRequestSchema
} from "@mapos/contracts";
import { photonAdapter } from "@mapos/service-adapters";
import type { Hono } from "hono";
import { z } from "zod";
import { loadEnv } from "../env";
import { handleContractPost } from "../route-helpers";

const ResultArraySchema = z.array(GeocodeResultSchema);

export function registerGeocoding(app: Hono): void {
  app.post("/v1/geocoding/forward", (c) =>
    handleContractPost(c, GeocodeForwardRequestSchema, ResultArraySchema, (req, signal) =>
      photonAdapter.geocoding.forward(req, { url: loadEnv(c.env).PHOTON_URL }, { signal })
    )
  );

  app.post("/v1/geocoding/reverse", (c) =>
    handleContractPost(c, GeocodeReverseRequestSchema, ResultArraySchema, (req, signal) =>
      photonAdapter.geocoding.reverse(req, { url: loadEnv(c.env).PHOTON_URL }, { signal })
    )
  );
}

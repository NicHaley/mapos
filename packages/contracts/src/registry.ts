/**
 * Registry-level identifiers shared between the dispatcher in `apps/dashboard` and the
 * eventual server. ServiceId names a capability the app calls; AdapterId names a
 * concrete protocol implementation that satisfies one or more services.
 */

import { z } from "zod";

export const ServiceIdSchema = z.enum([
  "geocoding",
  "routing",
  "isochrones",
  "tiles",
  "webSearch"
]);
export type ServiceId = z.infer<typeof ServiceIdSchema>;

export const AdapterIdSchema = z.enum([
  "photon",
  "valhalla",
  "protomaps",
  "mapos_v1",
  "tavily",
  "searxng"
]);
export type AdapterId = z.infer<typeof AdapterIdSchema>;

export const AuthCredentialSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  z.object({ type: z.literal("apikey"), value: z.string() }),
  z.object({ type: z.literal("bearer"), value: z.string() })
]);
export type AuthCredential = z.infer<typeof AuthCredentialSchema>;

export const EndpointSchema = z.object({
  url: z.string(),
  auth: AuthCredentialSchema.optional()
});
export type Endpoint = z.infer<typeof EndpointSchema>;

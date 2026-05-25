import {
  GeocodeForwardRequestSchema,
  GeocodeResultSchema,
  GeocodeReverseRequestSchema,
  TileStyleRequestSchema
} from "@mapos/contracts";
import { ipcMain } from "electron";
import { z } from "zod";
import { getServiceClient } from "./services/client";

const CHANNELS = [
  "services:geocoding-forward",
  "services:geocoding-reverse",
  "services:tiles-style-url"
] as const;

const GeocodeResultArraySchema = z.array(GeocodeResultSchema);
const TileStyleUrlSchema = z.string().url();

/**
 * Wrap a service handler so both the inbound request and the outbound response
 * are validated against the contract schemas. Schema failures are converted to
 * plain `Error`s — Electron only preserves `message` across IPC, so callers see
 * a single string describing what went wrong.
 */
function handler<Req, Res>(
  channel: string,
  reqSchema: z.ZodType<Req>,
  resSchema: z.ZodType<Res>,
  run: (req: Req) => Promise<Res> | Res
): void {
  ipcMain.handle(channel, async (_e, raw: unknown) => {
    const req = reqSchema.safeParse(raw);
    if (!req.success) throw formatZodError(`${channel} request`, req.error);
    const result = await run(req.data);
    const res = resSchema.safeParse(result);
    if (!res.success) throw formatZodError(`${channel} response`, res.error);
    return res.data;
  });
}

function formatZodError(label: string, err: z.ZodError): Error {
  const issues = err.issues
    .slice(0, 3)
    .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
    .join("; ");
  const more = err.issues.length > 3 ? ` (+${err.issues.length - 3} more)` : "";
  return new Error(`${label}: schema validation failed — ${issues}${more}`);
}

/**
 * Register renderer→main service handlers. The dispatcher singleton owns mode
 * resolution and adapter dispatch — these handlers are validation-only wrappers
 * so the renderer never sees provider details.
 *
 * AbortSignal does not cross IPC. Renderer-side debouncing + stale-result
 * detection in `searchPhoton` mitigates the loss of in-flight cancellation.
 */
export function registerServicesIpc(): void {
  handler(
    "services:geocoding-forward",
    GeocodeForwardRequestSchema,
    GeocodeResultArraySchema,
    (req) => getServiceClient().geocoding.forward(req)
  );
  handler(
    "services:geocoding-reverse",
    GeocodeReverseRequestSchema,
    GeocodeResultArraySchema,
    (req) => getServiceClient().geocoding.reverse(req)
  );
  handler("services:tiles-style-url", TileStyleRequestSchema, TileStyleUrlSchema, (req) =>
    getServiceClient().tiles.styleUrl(req)
  );
}

export function unregisterServicesIpc(): void {
  for (const ch of CHANNELS) ipcMain.removeHandler(ch);
}

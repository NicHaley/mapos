/**
 * The tile service is a URL service rather than a request/response one: callers
 * resolve a MapLibre style URL from the dispatcher and hand it directly to the
 * renderer. The contract is therefore just the inputs the dispatcher needs.
 */

import { z } from "zod";

export const TileStyleRequestSchema = z.object({
  isDark: z.boolean()
});
export type TileStyleRequest = z.infer<typeof TileStyleRequestSchema>;

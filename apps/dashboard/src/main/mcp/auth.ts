import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

/**
 * Verify the bearer token on an incoming MCP request. This is the *only* security boundary:
 * the server binds 127.0.0.1 and (via the transport) checks Host/Origin, but any local process
 * can reach the port, so a valid token is required on every request. Comparison is
 * length-checked then constant-time to avoid leaking the token via timing.
 */
export function isAuthorized(req: IncomingMessage, token: string): boolean {
  if (!token) return false;
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return false;
  const provided = Buffer.from(header.slice("Bearer ".length).trim());
  const expected = Buffer.from(token);
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

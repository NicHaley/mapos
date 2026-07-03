import { extname } from "node:path";
import { protocol } from "electron";
import { CORS, serveFile } from "./protocol-serve";

/**
 * Local scheme serving image bytes from the active vault so the renderer can
 * display vault attachments via plain <img> tags:
 *   mapos-vault://vault/<vault-relative-path>
 *
 * The hostname is a fixed sentinel — "standard" schemes lowercase the host, so
 * it can't carry the (case-sensitive) first path segment. Only image extensions
 * are served; SVG is deliberately excluded (script-capable format on a
 * privileged, fetch-capable scheme).
 */
export const VAULT_SCHEME = "mapos-vault";
export const VAULT_URL_HOST = "vault";

const SERVABLE_IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

function forbidden(): Response {
  return new Response("forbidden", { status: 403, headers: CORS });
}

/**
 * Run after app `ready`. The root is read per-request via `getVaultRoot` so
 * vault switches/renames need no re-registration.
 */
export function registerVaultProtocol(getVaultRoot: () => string): void {
  protocol.handle(VAULT_SCHEME, (request) => {
    const url = new URL(request.url);
    if (url.hostname !== VAULT_URL_HOST) return forbidden();
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    // Dot-leading segments block `..` traversal and hidden state (`.mapos/`).
    if (rel.length === 0 || rel.split("/").some((seg) => seg.startsWith("."))) {
      return forbidden();
    }
    if (!SERVABLE_IMAGE_EXTS.has(extname(rel).toLowerCase())) return forbidden();
    const root = getVaultRoot();
    if (!root) return new Response("not found", { status: 404, headers: CORS });
    const res = serveFile(root, rel, request.headers.get("range"));
    // Never cache: the renderer busts stale <img> renders with a ?v= param.
    res.headers.set("cache-control", "no-cache");
    return res;
  });
}

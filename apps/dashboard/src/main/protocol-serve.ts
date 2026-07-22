import { closeSync, openSync, readSync, statSync } from "node:fs";
import { join, normalize, sep } from "node:path";

/** Shared helpers for the app's local `protocol.handle` schemes. */

export const PRIVILEGES = {
  standard: true,
  secure: true,
  supportFetchAPI: true,
  stream: true,
  corsEnabled: true
} as const;

export const CORS = { "access-control-allow-origin": "*" } as const;

export function contentType(file: string): string {
  if (file.endsWith(".pmtiles")) return "application/octet-stream";
  if (file.endsWith(".json")) return "application/json";
  if (file.endsWith(".pbf")) return "application/x-protobuf";
  if (file.endsWith(".png")) return "image/png";
  if (file.endsWith(".jpg") || file.endsWith(".jpeg")) return "image/jpeg";
  if (file.endsWith(".gif")) return "image/gif";
  if (file.endsWith(".webp")) return "image/webp";
  return "application/octet-stream";
}

/** Serve a file under `root`, honouring a Range header. Guards path traversal. */
export function serveFile(root: string, rel: string, range: string | null): Response {
  const full = normalize(join(root, rel));
  if (full !== root && !full.startsWith(root + sep)) {
    return new Response("forbidden", { status: 403, headers: CORS });
  }
  let size: number;
  try {
    size = statSync(full).size;
  } catch {
    return new Response("not found", { status: 404, headers: CORS });
  }
  const headers: Record<string, string> = {
    ...CORS,
    "accept-ranges": "bytes",
    "content-type": contentType(rel)
  };
  const m = range ? /bytes=(\d*)-(\d*)/.exec(range) : null;
  if (m) {
    // Clamp to the file: an out-of-range `end` must never make readRange allocate
    // and return bytes past EOF (uninitialised heap → info-leak + wrong length).
    const start = Math.max(0, m[1] ? Number.parseInt(m[1], 10) : 0);
    const end = Math.min(size - 1, m[2] ? Number.parseInt(m[2], 10) : size - 1);
    if (start > end) {
      return new Response("range not satisfiable", {
        status: 416,
        headers: { ...headers, "content-range": `bytes */${size}` }
      });
    }
    const body = readRange(full, start, end);
    headers["content-range"] = `bytes ${start}-${start + body.length - 1}/${size}`;
    headers["content-length"] = String(body.length);
    return new Response(
      new Uint8Array(body.buffer as ArrayBuffer, body.byteOffset, body.byteLength),
      {
        status: 206,
        headers
      }
    );
  }
  const body = readRange(full, 0, size - 1);
  headers["content-length"] = String(body.length);
  return new Response(
    new Uint8Array(body.buffer as ArrayBuffer, body.byteOffset, body.byteLength),
    {
      status: 200,
      headers
    }
  );
}

// Reads bytes [start, end] from `path`. Returns only the bytes actually read —
// the buffer is sliced to the read count so a short read never exposes the
// uninitialised tail of the allocUnsafe buffer.
function readRange(path: string, start: number, end: number): Buffer {
  const len = Math.max(0, end - start + 1);
  const buf = Buffer.allocUnsafe(len);
  const fd = openSync(path, "r");
  try {
    let read = 0;
    while (read < len) {
      const n = readSync(fd, buf, read, len - read, start + read);
      if (n === 0) break;
      read += n;
    }
    return read === len ? buf : buf.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

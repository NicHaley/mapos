/**
 * The single entry point to node-llama-cpp's in-process runtime.
 *
 * Main-process only (it crashes in a renderer). The native addon and dylibs are unpacked from the
 * asar — see electron-builder.yml.
 */

import { type Llama, getLlama } from "node-llama-cpp";

let llamaPromise: Promise<Llama> | null = null;

/** Load the native addon and select the GPU backend, once per process. */
export function getLlamaRuntime(): Promise<Llama> {
  if (!llamaPromise) llamaPromise = getLlama();
  return llamaPromise;
}

/** Tear down the runtime on app quit. Dispose all models first, then call this. */
export async function disposeLlamaRuntime(): Promise<void> {
  const pending = llamaPromise;
  llamaPromise = null;
  if (!pending) return;
  try {
    await (await pending).dispose();
  } catch {
    /* already gone */
  }
}

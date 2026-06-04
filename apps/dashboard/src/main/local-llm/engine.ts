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

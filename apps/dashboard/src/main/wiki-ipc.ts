import { ipcMain } from "electron";
import { importAttachmentToVault } from "./watcher";
import { downloadWikidataImage, lookupWikidataImage } from "./wiki-image";

const QID_RE = /^Q\d+$/;

/**
 * Renderer-facing Wikimedia image IPC. `getVaultRoot` is a closure because the
 * active vault can change at runtime (same pattern as the vault protocol).
 */
export function registerWikiIpc(getVaultRoot: () => string): void {
  ipcMain.handle("wiki:image-lookup", async (_event, qid: unknown) => {
    if (typeof qid !== "string" || !QID_RE.test(qid)) return null;
    return lookupWikidataImage(qid);
  });

  ipcMain.handle("wiki:import-image", async (_event, qid: unknown) => {
    if (typeof qid !== "string" || !QID_RE.test(qid)) {
      return { success: false as const, error: "Invalid Wikidata id" };
    }
    const vaultRoot = getVaultRoot();
    if (!vaultRoot) return { success: false as const, error: "No vault open" };
    const downloaded = await downloadWikidataImage(qid);
    if (!downloaded) return { success: false as const, error: "No image available" };
    const imported = await importAttachmentToVault(vaultRoot, {
      suggestedName: downloaded.fileName,
      bytes: downloaded.bytes
    });
    if (!imported.success) return imported;
    return { success: true as const, relPath: imported.relPath, pageUrl: downloaded.pageUrl };
  });
}

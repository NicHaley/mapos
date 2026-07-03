import { mergeAttributes } from "@tiptap/core";
import Image from "@tiptap/extension-image";
import { Plugin, PluginKey } from "@tiptap/pm/state";

/**
 * Vault-aware Tiptap image node.
 *
 * The document model (and therefore `getMarkdown()`) always holds the
 * vault-relative path — `![](attachments/x.jpg)` on disk stays byte-stable.
 * Only `renderHTML` maps a relative src to the `mapos-vault://` protocol URL
 * the renderer can actually display, and the attribute-level `parseHTML`
 * reverses that mapping so copy/paste of our own rendered <img> tags
 * canonicalizes back to the relative path.
 */

const VAULT_URL_PREFIX = "mapos-vault://vault/";

/** True for vault-relative paths: no URL scheme, not absolute. */
export function isVaultRelativePath(src: string): boolean {
  if (!src || src.startsWith("/") || src.startsWith("\\")) return false;
  return !/^[a-z][a-z0-9+.-]*:/i.test(src);
}

/** `rev` cache-busts a stale <img> render after the file's bytes change. */
export function vaultImageUrl(relPath: string, rev?: number): string {
  const encoded = relPath.split("/").map(encodeURIComponent).join("/");
  return `${VAULT_URL_PREFIX}${encoded}${rev ? `?v=${rev}` : ""}`;
}

export function relPathFromVaultUrl(url: string): string | null {
  if (!url.startsWith(VAULT_URL_PREFIX)) return null;
  const rest = url.slice(VAULT_URL_PREFIX.length).replace(/[?#].*$/, "");
  try {
    return rest.split("/").map(decodeURIComponent).join("/");
  } catch {
    return null;
  }
}

function safeDecode(href: string): string {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}

export const VaultImage = Image.extend({
  // CommonMark forbids raw spaces in image destinations, so markdown on disk
  // holds percent-encoded hrefs (`![](attachments/my%20photo.png)`, Obsidian's
  // convention) while node attrs hold the decoded vault path.
  parseMarkdown: (token, helpers) =>
    helpers.createNode("image", {
      src: safeDecode(token.href ?? ""),
      alt: token.text || null,
      title: token.title || null
    }),

  renderMarkdown: (node) => {
    const src = String(node.attrs?.src ?? "");
    const href = isVaultRelativePath(src) ? src.split("/").map(encodeURIComponent).join("/") : src;
    const alt = String(node.attrs?.alt ?? "");
    const title = node.attrs?.title;
    return title ? `![${alt}](${href} "${title}")` : `![${alt}](${href})`;
  },

  addAttributes() {
    return {
      ...this.parent?.(),
      src: {
        default: null,
        parseHTML: (element: HTMLElement) => {
          const raw = element.getAttribute("src") ?? "";
          return relPathFromVaultUrl(raw) ?? raw;
        }
      }
    };
  },

  renderHTML({ node, HTMLAttributes }) {
    const src = String(node.attrs.src ?? "");
    const display = isVaultRelativePath(src) ? vaultImageUrl(src) : src;
    return ["img", mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, { src: display })];
  },

  addProseMirrorPlugins() {
    const editor = this.editor;

    const importAndInsert = async (file: File, insertAt?: number): Promise<void> => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const result = await window.api.fs.importAttachment({
        // Pasted screenshots arrive as a generic "image.png" — let main mint a
        // timestamped name instead so pastes don't pile up as "image 1/2/3.png".
        suggestedName: file.name && file.name !== "image.png" ? file.name : undefined,
        bytes
      });
      if (!result.success) {
        console.error("[vault-image] attachment import failed:", result.error);
        return;
      }
      const content = { type: "image", attrs: { src: result.relPath } };
      if (insertAt !== undefined) {
        editor
          .chain()
          .focus()
          .insertContentAt(Math.min(insertAt, editor.state.doc.content.size), content)
          .run();
      } else {
        editor.chain().focus().insertContent(content).run();
      }
    };

    return [
      new Plugin({
        key: new PluginKey("vaultImageImport"),
        props: {
          handlePaste: (_view, event) => {
            if (!editor.isEditable) return false;
            const item = Array.from(event.clipboardData?.items ?? []).find((i) =>
              i.type.startsWith("image/")
            );
            const file = item?.getAsFile();
            if (!file) return false;
            event.preventDefault();
            void importAndInsert(file);
            return true;
          },
          handleDrop: (view, event, _slice, moved) => {
            if (moved || !editor.isEditable) return false;
            const files = Array.from(event.dataTransfer?.files ?? []).filter((f) =>
              f.type.startsWith("image/")
            );
            if (files.length === 0) return false;
            event.preventDefault();
            // Capture the drop position before the async import; note a file
            // dragged from inside the vault is still copied into attachments/.
            const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
            void (async () => {
              for (const file of files) await importAndInsert(file, pos);
            })();
            return true;
          }
        }
      })
    ];
  }
});

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MapOverlayPayload, PersistedMessage } from "../shared/types";

export type ActiveConversation = {
  id: string;
  messages: PersistedMessage[];
  sdkSessionId?: string;
  overlay?: MapOverlayPayload | null;
};

export type ConversationMeta = {
  id: string;
  created_at: string;
  updated_at: string;
  messageCount: number;
  preview: string;
  sdkSessionId?: string;
};

let activeConversationsDir = "";
let activeConversationsIndex = "";

export function setConversationsDir(dir: string): void {
  activeConversationsDir = dir;
  activeConversationsIndex = join(dir, "index.jsonl");
}

export function newConversationId(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}-${rand}`;
}

export function loadConvState(id: string): { overlay: MapOverlayPayload | null } {
  try {
    const p = join(activeConversationsDir, `${id}.state.json`);
    if (!existsSync(p)) return { overlay: null };
    return JSON.parse(readFileSync(p, "utf-8")) as { overlay: MapOverlayPayload | null };
  } catch {
    return { overlay: null };
  }
}

export function saveConvState(id: string, state: { overlay: MapOverlayPayload | null }): void {
  try {
    writeFileSync(join(activeConversationsDir, `${id}.state.json`), JSON.stringify(state), "utf-8");
  } catch (err) {
    console.error("[main] failed to save conv state:", err);
  }
}

export function convToMeta(conv: ActiveConversation): ConversationMeta {
  const firstUser = conv.messages.find((m) => m.role === "user");
  return {
    id: conv.id,
    created_at: conv.messages[0]?.timestamp ?? new Date().toISOString(),
    updated_at: conv.messages[conv.messages.length - 1]?.timestamp ?? new Date().toISOString(),
    messageCount: conv.messages.length,
    preview: (firstUser?.content ?? "").slice(0, 100),
    sdkSessionId: conv.sdkSessionId
  };
}

export function readConversationIndex(): ConversationMeta[] {
  try {
    const lines = readFileSync(activeConversationsIndex, "utf-8").split("\n").filter(Boolean);
    const map = new Map<string, ConversationMeta>();
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as ConversationMeta;
        map.set(entry.id, entry);
      } catch {
        /* skip malformed lines */
      }
    }
    return Array.from(map.values()).sort((a, b) => a.created_at.localeCompare(b.created_at));
  } catch {
    return [];
  }
}

export function compactIndex(entries: ConversationMeta[]): void {
  try {
    writeFileSync(
      activeConversationsIndex,
      `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`,
      "utf-8"
    );
  } catch (err) {
    console.error("[main] failed to compact index:", err);
  }
}

export function appendToIndex(conv: ActiveConversation): void {
  try {
    appendFileSync(activeConversationsIndex, `${JSON.stringify(convToMeta(conv))}\n`, "utf-8");
  } catch (err) {
    console.error("[main] failed to append to index:", err);
  }
}

export function initConversationsDir(): void {
  if (!existsSync(activeConversationsDir)) {
    mkdirSync(activeConversationsDir, { recursive: true });
  }
  // Compact index on startup to deduplicate accumulated entries
  const entries = readConversationIndex();
  if (entries.length > 0) compactIndex(entries);
}

export function loadMostRecentConversation(): ActiveConversation | null {
  try {
    const entries = readConversationIndex();
    if (entries.length === 0) return null;
    const latest = entries[entries.length - 1];
    const lines = readFileSync(join(activeConversationsDir, `${latest.id}.jsonl`), "utf-8")
      .split("\n")
      .filter(Boolean);
    const messages = lines.flatMap((line) => {
      try {
        return [JSON.parse(line) as PersistedMessage];
      } catch {
        return [];
      }
    });
    const state = loadConvState(latest.id);
    return { id: latest.id, messages, sdkSessionId: latest.sdkSessionId, overlay: state.overlay };
  } catch {
    return null;
  }
}

export function appendMessage(conv: ActiveConversation, msg: PersistedMessage): void {
  try {
    appendFileSync(
      join(activeConversationsDir, `${conv.id}.jsonl`),
      `${JSON.stringify(msg)}\n`,
      "utf-8"
    );
    appendToIndex(conv);
  } catch (err) {
    console.error("[main] failed to append message:", err);
  }
}

export function getConversationFilePath(id: string): string {
  return join(activeConversationsDir, `${id}.jsonl`);
}

export function getConversationStateFilePath(id: string): string {
  return join(activeConversationsDir, `${id}.state.json`);
}

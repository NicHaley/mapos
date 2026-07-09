import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type { MapOverlayLayer, StashedGeometry } from "../shared/types";

export type ActiveConversation = {
  id: string;
  messages: Message[];
  sdkSessionId?: string;
  /** Accumulated overlay layers shown on the map for this conversation. */
  layers?: MapOverlayLayer[];
  title?: string;
};

export type ConversationMeta = {
  id: string;
  created_at: string;
  updated_at: string;
  messageCount: number;
  preview: string;
  sdkSessionId?: string;
  title?: string;
};

let activeConversationsDir = "";
let activeConversationsIndex = "";

export function setConversationsDir(dir: string): void {
  activeConversationsDir = dir;
  activeConversationsIndex = join(dir, "index.jsonl");
}

export type ConvState = {
  layers: MapOverlayLayer[];
  /** Geometry stash keyed by opaque handle (route_N / iso_N / geom_N). See StashedGeometry. */
  geometries: Record<string, StashedGeometry>;
};

export function loadConvState(id: string): ConvState {
  try {
    const p = join(activeConversationsDir, `${id}.state.json`);
    if (!existsSync(p)) return { layers: [], geometries: {} };
    const parsed = JSON.parse(readFileSync(p, "utf-8")) as Partial<ConvState>;
    return { layers: parsed.layers ?? [], geometries: parsed.geometries ?? {} };
  } catch {
    return { layers: [], geometries: {} };
  }
}

export function saveConvState(id: string, state: ConvState): void {
  try {
    writeFileSync(join(activeConversationsDir, `${id}.state.json`), JSON.stringify(state), "utf-8");
  } catch (err) {
    console.error("[main] failed to save conv state:", err);
  }
}

function firstUserText(messages: Message[]): string {
  const m = messages.find((x) => x.role === "user");
  if (!m) return "";
  if (typeof m.content === "string") return m.content;
  for (const block of m.content) {
    if (block.type === "text") return block.text;
  }
  return "";
}

function toIso(ts: number | undefined): string {
  return new Date(ts ?? Date.now()).toISOString();
}

export function convToMeta(conv: ActiveConversation): ConversationMeta {
  // toolResult messages exist purely as protocol scaffolding — they don't represent
  // a logical message to the user, so they're excluded from the count.
  const visible = conv.messages.filter((m) => m.role !== "toolResult");
  return {
    id: conv.id,
    created_at: toIso(conv.messages[0]?.timestamp),
    updated_at: toIso(conv.messages[conv.messages.length - 1]?.timestamp),
    messageCount: visible.length,
    preview: firstUserText(conv.messages).slice(0, 100),
    sdkSessionId: conv.sdkSessionId,
    ...(conv.title ? { title: conv.title } : {})
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

export function appendMessages(conv: ActiveConversation, msgs: Message[]): void {
  if (msgs.length === 0) return;
  try {
    appendFileSync(
      join(activeConversationsDir, `${conv.id}.jsonl`),
      `${msgs.map((m) => JSON.stringify(m)).join("\n")}\n`,
      "utf-8"
    );
    appendToIndex(conv);
  } catch (err) {
    console.error("[main] failed to append messages:", err);
  }
}

export function getConversationFilePath(id: string): string {
  return join(activeConversationsDir, `${id}.jsonl`);
}

export function getConversationStateFilePath(id: string): string {
  return join(activeConversationsDir, `${id}.state.json`);
}

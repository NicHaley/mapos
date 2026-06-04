/**
 * In-process inference over node-llama-cpp's low-level LlamaChat.
 *
 * LlamaChat (not the high-level LlamaChatSession) is deliberate: it *returns* the model's function
 * calls instead of executing them, which is what Pi's agent loop needs — Pi owns tool execution.
 *
 * The model and its context are loaded once per file and reused across turns. The context uses
 * node-llama-cpp's default "auto" size (largest that fits memory, up to the model's trained max), so
 * its KV cache — large at long context lengths — is allocated once, not rebuilt per message. A
 * single sequence means one generation at a time, so turns are serialized per model via a lock.
 */

import {
  type ChatHistoryItem,
  type ChatModelFunctions,
  LlamaChat,
  type LlamaContext,
  type LlamaModel
} from "node-llama-cpp";
import { getLlamaRuntime } from "./engine";

type LoadedModel = {
  model: LlamaModel;
  context: LlamaContext;
  chat: LlamaChat;
  /** Serializes turns: one sequence runs one generation at a time. */
  lock: Promise<unknown>;
};

const loaded = new Map<string, Promise<LoadedModel>>();

async function load(modelPath: string): Promise<LoadedModel> {
  const llama = await getLlamaRuntime();
  const model = await llama.loadModel({ modelPath });
  const context = await model.createContext(); // no contextSize => "auto"
  const chat = new LlamaChat({ contextSequence: context.getSequence() });
  return { model, context, chat, lock: Promise.resolve() };
}

function getLoaded(modelPath: string): Promise<LoadedModel> {
  let existing = loaded.get(modelPath);
  if (!existing) {
    existing = load(modelPath).catch((err) => {
      loaded.delete(modelPath); // don't cache a failed load
      throw err;
    });
    loaded.set(modelPath, existing);
  }
  return existing;
}

export type GenerateRequest = {
  modelPath: string;
  history: ChatHistoryItem[];
  functions?: ChatModelFunctions;
  maxTokens?: number;
  onText?: (chunk: string) => void;
  signal?: AbortSignal;
};

export type GenerateResult = {
  text: string;
  toolCalls: Array<{ name: string; params: unknown }>;
  /** node-llama-cpp stop reason: "functionCalls" | "eogToken" | "maxTokens" | "abort" | ... */
  stopReason: string;
};

/** A model's trained maximum and the context size we actually allocated (less only if memory-bound). */
export type ModelContextInfo = {
  trainContextSize: number;
  contextSize: number;
};

/** Load the model if needed and report its trained max plus the allocated context size. */
export async function getModelContextInfo(modelPath: string): Promise<ModelContextInfo> {
  const lm = await getLoaded(modelPath);
  return { trainContextSize: lm.model.trainContextSize, contextSize: lm.context.contextSize };
}

async function runTurn(lm: LoadedModel, req: GenerateRequest): Promise<GenerateResult> {
  const res = await lm.chat.generateResponse(req.history, {
    functions: req.functions,
    documentFunctionParams: true,
    maxTokens: req.maxTokens,
    signal: req.signal,
    onTextChunk: req.onText
  });
  return {
    text: res.response,
    toolCalls: (res.functionCalls ?? []).map((fc) => ({ name: fc.functionName, params: fc.params })),
    stopReason: res.metadata.stopReason
  };
}

/** Run one model turn: stream text via `onText`, return the final text plus any (unexecuted) calls. */
export async function generate(req: GenerateRequest): Promise<GenerateResult> {
  const lm = await getLoaded(req.modelPath);
  // Chain on the per-model lock so overlapping turns queue instead of racing on the one sequence.
  const run = lm.lock.then(() => runTurn(lm, req));
  lm.lock = run.then(
    () => undefined,
    () => undefined // a failed/aborted turn must not wedge the queue
  );
  return run;
}

/** Free a cached model and its context (e.g. after the user deletes or switches it). */
export async function unloadModel(modelPath: string): Promise<void> {
  const existing = loaded.get(modelPath);
  loaded.delete(modelPath);
  if (!existing) return;
  try {
    const lm = await existing;
    await lm.context.dispose();
    await lm.model.dispose();
  } catch {
    /* already gone */
  }
}

/** Dispose every loaded model. Call on app quit to avoid the GGML shutdown assertion. */
export async function unloadAllModels(): Promise<void> {
  await Promise.all([...loaded.keys()].map((p) => unloadModel(p)));
}

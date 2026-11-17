import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { authHeaders, streamUrl } from "./client";
import { openEventStream, type EventStream } from "./eventStream";
import type { MessagePart, Pending, QueuedMessage, ToolActivity, ToolStep } from "./types";

export interface LiveState {
  parts: MessagePart[];
  partial: { kind: "text" | "thinking"; text: string } | null;
  error: string | null;
  pending: Pending[];
  queue: QueuedMessage[];
  background: string[];
  lastEventAt: number;
}

const emptyLive = (pending: Pending[] = [], queue: QueuedMessage[] = []): LiveState => ({
  parts: [],
  partial: null,
  error: null,
  pending,
  queue,
  background: [],
  lastEventAt: Date.now(),
});

export interface StreamHandlers {
  onSessionId?: (sessionId: string) => void;
  onTurn?: (parts: MessagePart[]) => void;
  onQueueStarted?: (prompt: string) => void;
  onSettled?: (finished: boolean) => void;
}

export function partsOf(state: LiveState): MessagePart[] {
  const parts = [...state.parts];
  if (state.partial?.text) parts.push({ kind: state.partial.kind, text: state.partial.text });
  return parts;
}

function collect(state: LiveState): MessagePart[] {
  const parts = partsOf(state);
  if (state.error) parts.push({ kind: "text", text: `Error: ${state.error}` });
  return parts;
}

function stepSubject(input: Record<string, unknown>): string {
  const value = input.description || input.command || input.file_path || input.path || input.pattern || input.url || input.query || "";
  return String(value).replace(/\s+/g, " ").slice(0, 80);
}

function withSteps(
  parts: MessagePart[],
  parentId: string,
  change: (steps: ToolStep[]) => ToolStep[],
): MessagePart[] {
  return parts.map((part) =>
    part.kind === "tool" && part.id === parentId ? { ...part, steps: change(part.steps ?? []) } : part,
  );
}

function resultText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return raw.map((part) => (part as { text?: string }).text ?? "").join("\n");
  return "";
}

export function useRunStream(handlers: StreamHandlers = {}) {
  const [runId, setRunId] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState(0);
  const [live, setLive] = useState<LiveState | null>(null);

  const sourceRef = useRef<EventStream | null>(null);
  const runIdRef = useRef<string | null>(null);
  const lastSeqRef = useRef(-1);
  const seenRef = useRef<Set<string>>(new Set());
  const liveRef = useRef<LiveState | null>(null);
  const handlersRef = useRef(handlers);
  useLayoutEffect(() => {
    handlersRef.current = handlers;
  });

  const reset = useCallback(() => {
    sourceRef.current?.close();
    sourceRef.current = null;
    runIdRef.current = null;
    lastSeqRef.current = -1;
    liveRef.current = null;
    setLive(null);
    setRunId(null);
    setStartedAt(0);
  }, []);

  const commit = useCallback((next: LiveState) => {
    liveRef.current = next;
    setLive(next);
  }, []);

  const connect = useCallback(
    function open(id: string) {
      const onData = (data: string, seq: number | null) => {
        if (seq !== null) lastSeqRef.current = Math.max(lastSeqRef.current, seq);
        const current = liveRef.current;
        if (!current) return;

        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(data);
        } catch {
          return;
        }

        const sessionId = payload.session_id;
        if (typeof sessionId === "string") handlersRef.current.onSessionId?.(sessionId);

        const next: LiveState = { ...current, lastEventAt: Date.now() };
        const subagent = payload.parent_tool_use_id != null;

        switch (payload.type) {
          case "stream_event": {
            if (subagent) break;
            const inner = payload.event as
              | {
                  type?: string;
                  content_block?: { type?: string };
                  delta?: { type?: string; text?: string; thinking?: string };
                }
              | undefined;
            if (inner?.type === "content_block_start") {
              const kind = inner.content_block?.type;
              next.partial = kind === "text" || kind === "thinking" ? { kind, text: "" } : null;
            } else if (inner?.type === "content_block_delta") {
              const delta = inner.delta;
              if (delta?.type === "text_delta") {
                const base = next.partial?.kind === "text" ? next.partial.text : "";
                next.partial = { kind: "text", text: base + (delta.text ?? "") };
              } else if (delta?.type === "thinking_delta") {
                const base = next.partial?.kind === "thinking" ? next.partial.text : "";
                next.partial = { kind: "thinking", text: base + (delta.thinking ?? "") };
              }
            }
            break;
          }
          case "assistant": {
            if (subagent) {
              const parentId = String(payload.parent_tool_use_id);
              const content = (payload.message as { content?: unknown[] } | undefined)?.content ?? [];
              const calls = (content as Record<string, unknown>[]).filter((block) => block.type === "tool_use");
              if (!calls.length) break;
              next.parts = withSteps(next.parts, parentId, (steps) => [
                ...steps,
                ...calls
                  .filter((block) => !steps.some((step) => step.id === String(block.id)))
                  .map((block) => ({
                    id: String(block.id),
                    name: String(block.name),
                    subject: stepSubject((block.input ?? {}) as Record<string, unknown>),
                    state: "working" as const,
                  })),
              ]);
              break;
            }
            const key = String(payload.uuid ?? "");
            if (key && seenRef.current.has(key)) break;
            if (key) seenRef.current.add(key);
            const content = (payload.message as { content?: unknown[] } | undefined)?.content ?? [];
            const parts = [...next.parts];
            for (const block of content as Record<string, unknown>[]) {
              if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
                parts.push({ kind: "text", text: block.text });
              } else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking) {
                parts.push({ kind: "thinking", text: block.thinking });
              } else if (block.type === "tool_use") {
                const toolId = String(block.id);
                if (parts.some((part) => part.kind === "tool" && part.id === toolId)) continue;
                parts.push({
                  kind: "tool",
                  id: toolId,
                  name: String(block.name),
                  input: (block.input ?? {}) as Record<string, unknown>,
                });
              }
            }
            next.parts = parts;
            next.partial = null;
            break;
          }
          case "user": {
            const content = (payload.message as { content?: unknown[] } | undefined)?.content ?? [];
            if (!Array.isArray(content)) break;
            if (subagent) {
              const parentId = String(payload.parent_tool_use_id);
              for (const block of content as Record<string, unknown>[]) {
                if (block.type !== "tool_result") continue;
                const state = block.is_error ? ("failed" as const) : ("done" as const);
                next.parts = withSteps(next.parts, parentId, (steps) =>
                  steps.map((step) => (step.id === block.tool_use_id ? { ...step, state } : step)),
                );
              }
              break;
            }
            let parts = next.parts;
            for (const block of content as Record<string, unknown>[]) {
              if (block.type !== "tool_result") continue;
              parts = parts.map((part) =>
                part.kind === "tool" && part.id === block.tool_use_id
                  ? { ...part, result: { isError: Boolean(block.is_error), text: resultText(block.content) } }
                  : part,
              );
            }
            next.parts = parts;
            break;
          }
          case "system": {
            if (payload.subtype === "background_tasks_changed") {
              const tasks = (payload.tasks as { description?: string; ambient?: boolean }[] | undefined) ?? [];
              next.background = tasks.filter((task) => !task.ambient).map((task) => String(task.description ?? ""));
              break;
            }
            const toolId = typeof payload.tool_use_id === "string" ? payload.tool_use_id : null;
            if (!toolId) break;
            const usage = payload.usage as { tool_uses?: number } | undefined;
            const update = (activity: ToolActivity | undefined): ToolActivity => {
              const base = activity ?? { toolUses: 0, state: "working" as const };
              if (payload.subtype === "task_progress") {
                return {
                  ...base,
                  toolUses: usage?.tool_uses ?? base.toolUses,
                  lastTool: typeof payload.last_tool_name === "string" ? payload.last_tool_name : base.lastTool,
                  summary: typeof payload.summary === "string" ? payload.summary : base.summary,
                };
              }
              if (payload.subtype === "task_notification") {
                return {
                  ...base,
                  toolUses: usage?.tool_uses ?? base.toolUses,
                  state: payload.status === "completed" ? "done" : "failed",
                };
              }
              return base;
            };
            if (!["task_started", "task_progress", "task_notification"].includes(String(payload.subtype))) break;
            next.parts = next.parts.map((part) =>
              part.kind === "tool" && part.id === toolId ? { ...part, activity: update(part.activity) } : part,
            );
            break;
          }
          case "question_request":
          case "permission_request": {
            const item = payload as unknown as Pending;
            if (!next.pending.some((entry) => entry.id === item.id)) {
              next.pending = [...next.pending, item];
              navigator.vibrate?.([60, 40, 60]);
            }
            break;
          }
          case "permission_resolved": {
            next.pending = next.pending.filter((entry) => entry.id !== payload.id);
            break;
          }
          case "runner_error": {
            next.error = String(payload.message ?? "Run failed");
            break;
          }
          case "result": {
            if (payload.is_error && payload.subtype !== "error_during_execution") {
              next.error = String(payload.result ?? "Run failed");
            }
            break;
          }
          case "queued": {
            const item = { id: String(payload.id), prompt: String(payload.prompt ?? "") };
            if (!next.queue.some((entry) => entry.id === item.id)) next.queue = [...next.queue, item];
            break;
          }
          case "unqueued": {
            next.queue = next.queue.filter((entry) => entry.id !== payload.id);
            break;
          }
          case "queue_started": {
            next.queue = next.queue.filter((entry) => entry.id !== payload.id);
            handlersRef.current.onQueueStarted?.(String(payload.prompt ?? ""));
            break;
          }
          case "gap": {
            handlersRef.current.onSettled?.(false);
            break;
          }
          case "turn_done": {
            const parts = collect(next);
            if (parts.length) handlersRef.current.onTurn?.(parts);
            next.parts = [];
            next.partial = null;
            next.error = null;
            break;
          }
          case "runner_done": {
            const parts = collect(next);
            reset();
            if (parts.length) handlersRef.current.onTurn?.(parts);
            handlersRef.current.onSettled?.(true);
            return;
          }
          default:
            break;
        }

        commit(next);
      };

      const onError = (gone: boolean) => {
        source.close();
        if (sourceRef.current !== source) return;
        sourceRef.current = null;
        if (gone) {
          reset();
          handlersRef.current.onSettled?.(true);
          return;
        }
        window.setTimeout(() => {
          if (liveRef.current && runIdRef.current === id && !sourceRef.current) open(id);
        }, 1500);
      };

      const source = openEventStream(streamUrl(id, lastSeqRef.current + 1), authHeaders(), onData, onError);
      sourceRef.current = source;
    },
    [commit, reset],
  );

  const attach = useCallback(
    (id: string, started: number, pending: Pending[] = [], queue: QueuedMessage[] = []) => {
      sourceRef.current?.close();
      sourceRef.current = null;
      runIdRef.current = id;
      lastSeqRef.current = -1;
      seenRef.current = new Set();
      const initial = emptyLive(pending, queue);
      liveRef.current = initial;
      setLive(initial);
      setRunId(id);
      setStartedAt(started || Date.now());
      connect(id);
    },
    [connect],
  );

  useEffect(() => {
    const revive = () => {
      if (document.visibilityState === "hidden") return;
      const id = runIdRef.current;
      if (!id || !liveRef.current) return;
      sourceRef.current?.close();
      sourceRef.current = null;
      connect(id);
    };
    document.addEventListener("visibilitychange", revive);
    window.addEventListener("online", revive);
    window.addEventListener("pageshow", revive);
    return () => {
      document.removeEventListener("visibilitychange", revive);
      window.removeEventListener("online", revive);
      window.removeEventListener("pageshow", revive);
    };
  }, [connect]);

  const resolvePending = useCallback((id: string) => {
    const current = liveRef.current;
    if (!current) return;
    commit({ ...current, pending: current.pending.filter((entry) => entry.id !== id) });
  }, [commit]);

  useEffect(() => () => sourceRef.current?.close(), []);

  const dropQueued = useCallback((id: string) => {
    const current = liveRef.current;
    if (!current) return;
    commit({ ...current, queue: current.queue.filter((entry) => entry.id !== id) });
  }, [commit]);

  return { runId, startedAt, live, attach, detach: reset, resolvePending, dropQueued };
}

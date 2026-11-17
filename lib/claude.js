import { query } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { UPLOAD_ROOT } from "./config.js";

const PERMISSION_TIMEOUT_MS = Number(process.env.PERMISSION_TIMEOUT_MS || 30 * 60 * 1000);
const MAX_QUEUE = 20;
const BACKGROUND_GRACE_MS = 10_000;

const runs = new Map();

function formatAnswers(questions, answers) {
  const lines = [];
  questions.forEach((question, index) => {
    const answer = (answers || [])[index] || {};
    const picked = [...(answer.selected || [])];
    if (answer.other && answer.other.trim()) picked.push(answer.other.trim());
    const label = question.header || question.question || `Question ${index + 1}`;
    lines.push(`${label}: ${picked.length ? picked.join(", ") : "(no answer)"}`);
  });
  return [
    "The user answered your questions.",
    "",
    ...lines,
    "",
    "Continue with these answers. Do not ask again.",
  ].join("\n");
}

function userMessage(text) {
  return {
    type: "user",
    session_id: "",
    parent_tool_use_id: null,
    message: { role: "user", content: [{ type: "text", text }] },
    uuid: randomUUID(),
  };
}

export const getRun = (runId) => runs.get(runId);

export function listRuns() {
  return [...runs.values()].map((run) => ({
    runId: run.runId,
    sessionId: run.sessionId,
    cwd: run.cwd,
    status: run.status,
    startedAt: run.startedAt,
    prompt: run.prompt.slice(0, 120),
    pending: [...run.pending.values()].map((entry) => entry.payload),
    queued: run.queue.map((item) => ({ id: item.id, prompt: item.text.slice(0, 160) })),
    background: run.background.map((task) => task.description),
  }));
}

export function startRun({ cwd, sessionId, prompt, model, permissionMode, effort, addDirs = [] }) {
  const runId = randomUUID();
  const abort = new AbortController();

  const run = {
    runId,
    cwd,
    sessionId: sessionId || null,
    prompt,
    status: "running",
    startedAt: Date.now(),
    events: [],
    listeners: new Set(),
    pending: new Map(),
    queue: [],
    abort,
    wake: null,
    closed: false,
    turnOpen: true,
    seq: 0,
    background: [],
    backgroundIdleSince: 0,
  };
  runs.set(runId, run);

  const emit = (event) => {
    const subagent = event.parent_tool_use_id != null;
    if (event.type === "stream_event" && subagent) return;
    const entry = { seq: run.seq++, event };
    if (event.type === "assistant" && !subagent) {
      run.events = run.events.filter((item) => item.event.type !== "stream_event");
    }
    run.events.push(entry);
    if (run.events.length > 12000) run.events.splice(0, 6000);
    for (const listener of run.listeners) {
      try { listener(entry); } catch {}
    }
  };
  run.emit = emit;

  const wake = () => {
    const resolve = run.wake;
    run.wake = null;
    resolve?.();
  };

  async function* input() {
    yield userMessage(prompt);
    while (!run.closed) {
      if (run.turnOpen) {
        await new Promise((resolve) => {
          run.wake = resolve;
          setTimeout(resolve, 200);
        });
        continue;
      }
      const settling = Date.now() - run.backgroundIdleSince < BACKGROUND_GRACE_MS;
      if (!run.queue.length && (run.background.length || settling)) {
        await new Promise((resolve) => {
          run.wake = resolve;
          setTimeout(resolve, 1000);
        });
        continue;
      }
      if (!run.queue.length) {
        run.closed = true;
        break;
      }
      const next = run.queue.shift();
      run.turnOpen = true;
      run.interrupted = false;
      emit({ type: "queue_started", id: next.id, prompt: next.text, remaining: run.queue.length });
      yield userMessage(next.text);
    }
  }

  const canUseTool = (toolName, toolInput, meta) =>
    new Promise((resolve) => {
      const id = meta.toolUseID || randomUUID();

      if (toolName === "AskUserQuestion" && Array.isArray(toolInput?.questions)) {
        const payload = {
          id,
          kind: "question",
          questions: toolInput.questions.map((question) => ({
            header: question.header || "",
            question: question.question || "",
            multiSelect: !!question.multiSelect,
            options: (question.options || []).map((option) => ({
              label: option.label || "",
              description: option.description || "",
            })),
          })),
        };

        const timer = setTimeout(() => {
          if (!run.pending.has(id)) return;
          run.pending.delete(id);
          emit({ type: "permission_resolved", id, decision: "timeout" });
          resolve({ behavior: "deny", message: "The user did not answer in time." });
        }, PERMISSION_TIMEOUT_MS);

        run.pending.set(id, {
          payload,
          kind: "question",
          settle(decision, answers) {
            clearTimeout(timer);
            run.pending.delete(id);
            emit({ type: "permission_resolved", id, decision: "answered" });
            if (decision === "cancel") {
              resolve({ behavior: "deny", message: "The user dismissed the question without answering." });
              return;
            }
            resolve({ behavior: "deny", message: formatAnswers(payload.questions, answers) });
          },
        });

        emit({ type: "question_request", ...payload });
        return;
      }

      const payload = {
        id,
        kind: "permission",
        toolName,
        input: toolInput,
        title: meta.title || null,
        displayName: meta.displayName || toolName,
        description: meta.description || null,
        blockedPath: meta.blockedPath || null,
        decisionReason: meta.decisionReason || null,
        canAlwaysAllow: !!(meta.suggestions && meta.suggestions.length),
      };

      const timer = setTimeout(() => {
        if (!run.pending.has(id)) return;
        run.pending.delete(id);
        emit({ type: "permission_resolved", id, decision: "timeout" });
        resolve({ behavior: "deny", message: "No answer in time." });
      }, PERMISSION_TIMEOUT_MS);

      run.pending.set(id, {
        payload,
        kind: "permission",
        settle(decision) {
          clearTimeout(timer);
          run.pending.delete(id);
          emit({ type: "permission_resolved", id, decision });
          if (decision === "allow") resolve({ behavior: "allow", updatedInput: toolInput });
          else if (decision === "always") {
            resolve({
              behavior: "allow",
              updatedInput: toolInput,
              updatedPermissions: meta.suggestions || [],
            });
          } else resolve({ behavior: "deny", message: "The user denied this." });
        },
      });

      emit({ type: "permission_request", ...payload });
    });

  (async () => {
    try {
      const session = query({
        prompt: input(),
        options: {
          cwd,
          abortController: abort,
          includePartialMessages: true,
          systemPrompt: { type: "preset", preset: "claude_code" },
          settingSources: ["user", "project", "local"],
          additionalDirectories: [UPLOAD_ROOT, ...addDirs],
          permissionMode: permissionMode || "default",
          canUseTool,
          ...(sessionId ? { resume: sessionId } : {}),
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
        },
      });

      run.session = session;

      for await (const message of session) {
        if (message.session_id) run.sessionId = message.session_id;
        if (message.type === "system" && message.subtype === "background_tasks_changed") {
          const active = (message.tasks || []).filter((task) => !task.ambient);
          if (run.background.length && !active.length) run.backgroundIdleSince = Date.now();
          run.background = active;
          wake();
        }
        if (!run.turnOpen && message.parent_tool_use_id == null && (message.type === "assistant" || message.type === "stream_event")) {
          run.turnOpen = true;
        }
        emit(message);

        if (message.type === "result") {
          run.turnOpen = false;
          emit({ type: "turn_done", subtype: message.subtype, queued: run.queue.length });
          wake();
        }
      }
      if (run.status === "running") run.status = "done";
    } catch (error) {
      const quiet = abort.signal.aborted || (run.interrupted && run.closed);
      if (run.status === "running") run.status = abort.signal.aborted ? "stopped" : quiet ? "done" : "error";
      if (!quiet) emit({ type: "runner_error", message: String(error?.message || error) });
    } finally {
      run.closed = true;
      wake();
      for (const entry of [...run.pending.values()]) {
        entry.settle(entry.kind === "question" ? "cancel" : "deny");
      }
      emit({ type: "runner_done", status: run.status, sessionId: run.sessionId });
      setTimeout(() => runs.delete(runId), 15 * 60 * 1000);
    }
  })();

  return run;
}

export function enqueueMessage(runId, text) {
  const run = runs.get(runId);
  if (!run) return { ok: false, error: "Run not found" };
  if (run.status !== "running" || run.closed) return { ok: false, error: "That run has finished" };
  if (!text || !text.trim()) return { ok: false, error: "Empty message" };
  if (run.queue.length >= MAX_QUEUE) return { ok: false, error: `Queue is full (${MAX_QUEUE})` };

  const item = { id: randomUUID(), text: text.trim() };
  run.queue.push(item);
  const wake = run.wake;
  run.wake = null;
  wake?.();

  run.emit({ type: "queued", id: item.id, prompt: item.text, position: run.queue.length });
  return { ok: true, id: item.id, position: run.queue.length };
}

export function dequeueMessage(runId, id) {
  const run = runs.get(runId);
  if (!run) return { ok: false, error: "Run not found" };
  const at = run.queue.findIndex((item) => item.id === id);
  if (at === -1) return { ok: false, error: "Not in the queue any more" };
  run.queue.splice(at, 1);
  run.emit({ type: "unqueued", id, remaining: run.queue.length });
  return { ok: true };
}

export function answerQuestion(runId, id, answers, cancel = false) {
  const run = runs.get(runId);
  if (!run) return { ok: false, error: "Run not found" };
  const entry = run.pending.get(id);
  if (!entry) return { ok: false, error: "That question is no longer open" };
  if (entry.kind !== "question") return { ok: false, error: "That request is not a question" };
  entry.settle(cancel ? "cancel" : "answer", answers);
  return { ok: true };
}

export function answerPermission(runId, id, decision) {
  const run = runs.get(runId);
  if (!run) return { ok: false, error: "Run not found" };
  const entry = run.pending.get(id);
  if (!entry) return { ok: false, error: "That request is no longer open" };
  if (!["allow", "always", "deny"].includes(decision)) return { ok: false, error: "Invalid decision" };
  entry.settle(decision);
  return { ok: true };
}

export async function interruptRun(runId) {
  const run = runs.get(runId);
  if (!run || run.status !== "running" || !run.session) return false;
  if (!run.turnOpen) return false;
  for (const item of run.queue.splice(0)) run.emit({ type: "unqueued", id: item.id, remaining: 0 });
  run.interrupted = true;
  try {
    await run.session.interrupt();
    return true;
  } catch {
    return false;
  }
}

export function stopRun(runId) {
  const run = runs.get(runId);
  if (!run) return false;
  run.status = "stopped";
  run.closed = true;
  run.queue.length = 0;
  const wake = run.wake;
  run.wake = null;
  wake?.();
  for (const entry of [...run.pending.values()]) {
    entry.settle(entry.kind === "question" ? "cancel" : "deny");
  }
  try { run.abort.abort(); } catch {}
  return true;
}

export function subscribe(run, listener) {
  run.listeners.add(listener);
  return () => run.listeners.delete(listener);
}

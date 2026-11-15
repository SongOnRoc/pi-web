// End-to-end: a real model asks through `ask_user_question`, the page is told
// about it over SSE, and its answer settles the tool call.
//
// The card's rendering is covered by unit tests; this covers the part a unit test
// cannot: the tool, the runtime, the event wire and the answer command together,
// against a running Pi Web and a real provider.
//
//   node e2e/ask-question.mjs [base] [cwd]

import assert from "node:assert/strict";

const BASE = process.argv[2] ?? process.env.PI_WEB_BASE ?? "http://127.0.0.1:31001";
const CWD = process.argv[3] ?? process.env.PI_WEB_CWD ?? process.cwd();
const MODEL = process.env.PI_WEB_MODEL ?? "csc/DeepSeek-V4.1-Flash-Reasoning";
const [PROVIDER, MODEL_ID] = (() => {
  const slash = MODEL.indexOf("/");
  return slash > 0 ? [MODEL.slice(0, slash), MODEL.slice(slash + 1)] : ["csc", MODEL];
})();

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function get(path) {
  const response = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(30_000) });
  assert.ok(response.ok, `GET ${path} -> ${response.status}`);
  return response.json();
}

/** Poll until `read` returns something, or the budget runs out. */
async function waitFor(read, budgetMs) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const value = await read().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() > deadline) return undefined;
    await delay(500);
  }
}

async function post(path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  assert.ok(response.ok, `POST ${path} -> ${response.status} ${text.slice(0, 300)}`);
  return text === "" ? {} : JSON.parse(text);
}

/** Read SSE events until `stop` returns a value, or the deadline passes. */
async function collect(sessionId, onEvent, stop) {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 240_000);
  try {
    const response = await fetch(`${BASE}/api/agent/${sessionId}/events`, { signal: controller.signal });
    assert.ok(response.ok, `events -> ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let cut;
      while ((cut = buffer.indexOf("\n\n")) >= 0) {
        const chunk = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const line = chunk.split("\n").find((item) => item.startsWith("data:"));
        if (!line) continue;
        let event;
        try {
          event = JSON.parse(line.slice(5).trim());
        } catch {
          continue;
        }
        const result = await onEvent(event);
        if (result !== undefined) return result;
        const finished = stop?.(event);
        if (finished !== undefined) return finished;
      }
    }
  } finally {
    clearTimeout(deadline);
    controller.abort();
  }
  return undefined;
}

async function main() {
  // A fresh session, so no other transcript can hold an ask_user_question call.
  const created = await post("/api/agent/new", { cwd: CWD, type: "ensure_session", provider: PROVIDER, modelId: MODEL_ID });
  const sessionId = created.sessionId;
  assert.ok(sessionId, `no sessionId in ${JSON.stringify(created)}`);

  const seen = [];
  const prompt = "Call the ask_user_question tool exactly once with one question: id \"env\", question \"Deploy to which environment?\", options \"Staging (Recommended)\" and \"Production\", no multi_select. Then stop and tell me what I picked.";

  const pending = collect(sessionId, async (event) => {
    seen.push(event.type);
    if (event.type === "ask_question_request") {
      // The reason this works at all: the card's questions come from the call.
      assert.equal(event.request.questions.length, 1);
      const [question] = event.request.questions;
      assert.equal(question.id, "env");
      assert.deepEqual(question.options.map((option) => option.label), ["Staging (Recommended)", "Production"]);
      return { toolCallId: event.toolCallId, request: event.request };
    }
    return undefined;
  });

  // The prompt is refused if the session is not ready yet; retry briefly.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await post(`/api/agent/${sessionId}`, { type: "prompt", message: prompt });
      break;
    } catch (error) {
      if (attempt === 39) throw error;
      await delay(500);
    }
  }

  const asked = await pending;
  assert.ok(asked, `no ask_question_request arrived; saw ${[...new Set(seen)].join(", ")}`);

  // Answer as the card does: one command, by tool call id.
  await post(`/api/agent/${sessionId}`, {
    type: "answer_question",
    toolCallId: asked.toolCallId,
    reply: {
      status: "answered",
      answers: [{ id: "env", selected: ["Production"] }],
    },
  });

  // Read the settled transcript rather than a second event stream: the answer may
  // land before a new subscription is open.
  const settled = await waitFor(async () => {
    const context = await get(`/api/sessions/${sessionId}/context?tail=40&deferMedia=1`);
    const messages = context.context?.messages ?? context.messages ?? [];
    const toolResult = messages.find((message) => message.role === "toolResult" && message.toolCallId === asked.toolCallId);
    const assistant = messages.filter((message) => message.role === "assistant").at(-1);
    if (!toolResult) return undefined;
    return { toolResult, assistant };
  }, 180_000);

  assert.ok(settled, "the run never settled after the answer");
  const toolText = (settled.toolResult.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join(" ");
  assert.match(toolText, /env: Production/);
  assert.equal(settled.toolResult.isError ?? false, false);

  // The settled transcript is not read again: its shape differs between a live and a
  // reopened session, and the tool result above already proves the round trip.

  // `post` returns the route's envelope, whose payload is `data`.
  const closed = await post(`/api/agent/${sessionId}`, { type: "open_questions" });
  assert.deepEqual(closed.data?.questions ?? closed.questions ?? [], [], "the answered call is no longer open");

  console.log("ok: the model asked, the page answered, the tool returned —", toolText.trim());
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);

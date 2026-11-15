import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { AskQuestionRuntime } = await jiti.import("./ask-question-runtime.ts");

/** A runtime whose events are collected instead of sent. */
function makeRuntime(timeoutMs) {
  const events = [];
  const runtime = new AskQuestionRuntime({ emit: (event) => events.push(event) }, timeoutMs);
  return { runtime, events };
}

const REQUEST = {
  questions: [{ id: "env", question: "Deploy where?", options: [{ label: "Staging" }, { label: "Production" }], multiSelect: false }],
};

test("asking announces the call and settles with the answer", async () => {
  const { runtime, events } = makeRuntime(60_000);
  const pending = runtime.ask("call-1", REQUEST);
  assert.deepEqual(events[0], { type: "ask_question_request", toolCallId: "call-1", request: REQUEST });
  assert.deepEqual(runtime.open().map((entry) => entry.toolCallId), ["call-1"]);

  assert.deepEqual(runtime.answer("call-1", { status: "answered", answers: [{ id: "env", selected: ["Production"] }] }), { ok: true });
  assert.deepEqual(await pending, { status: "answered", answers: [{ id: "env", selected: ["Production"] }] });
  assert.deepEqual(events.at(-1), { type: "ask_question_close", toolCallId: "call-1" });
  assert.deepEqual(runtime.open(), []);
});

test("a malformed answer leaves the question open", async () => {
  const { runtime } = makeRuntime(60_000);
  const pending = runtime.ask("call-1", REQUEST);
  const rejected = runtime.answer("call-1", { status: "answered", answers: [{ id: "env", selected: ["Nope"] }] });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /does not offer/);
  // Still answerable: a bad click must not cost the user their question.
  assert.deepEqual(runtime.open().map((entry) => entry.toolCallId), ["call-1"]);
  runtime.answer("call-1", { status: "skipped", answers: [{ id: "env", selected: [] }] });
  assert.deepEqual(await pending, { status: "skipped", answers: [{ id: "env", selected: [] }] });
});

test("answering a call that is no longer open is reported, not thrown", () => {
  const { runtime } = makeRuntime(60_000);
  const result = runtime.answer("gone", { status: "cancelled" });
  assert.equal(result.ok, false);
  assert.match(result.error, /no longer open/);
});

test("an abort settles the call as cancelled", async () => {
  const { runtime, events } = makeRuntime(60_000);
  const controller = new AbortController();
  const pending = runtime.ask("call-1", REQUEST, controller.signal);
  controller.abort();
  assert.deepEqual(await pending, { status: "cancelled", answers: [] });
  assert.deepEqual(events.at(-1), { type: "ask_question_close", toolCallId: "call-1" });
});

test("an already-aborted signal settles at once without asking", async () => {
  const { runtime, events } = makeRuntime(60_000);
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await runtime.ask("call-1", REQUEST, controller.signal), { status: "cancelled", answers: [] });
  assert.deepEqual(events, []);
});

test("Stop settles every open question", async () => {
  const { runtime, events } = makeRuntime(60_000);
  const first = runtime.ask("call-1", REQUEST);
  const second = runtime.ask("call-2", REQUEST);
  runtime.cancelAll();
  assert.deepEqual(await first, { status: "cancelled", answers: [] });
  assert.deepEqual(await second, { status: "cancelled", answers: [] });
  assert.deepEqual(runtime.open(), []);
  assert.equal(events.filter((event) => event.type === "ask_question_close").length, 2);
});

test("the timeout settles as cancelled rather than skipped", async () => {
  const { runtime } = makeRuntime(10);
  assert.deepEqual(await runtime.ask("call-1", REQUEST), { status: "cancelled", answers: [] });
  assert.deepEqual(runtime.open(), []);
});

test("asking twice for one call settles the first as cancelled", async () => {
  const { runtime } = makeRuntime(60_000);
  const first = runtime.ask("call-1", REQUEST);
  const second = runtime.ask("call-1", REQUEST);
  assert.deepEqual(await first, { status: "cancelled", answers: [] });
  runtime.answer("call-1", { status: "cancelled" });
  assert.deepEqual(await second, { status: "cancelled", answers: [] });
});

test("open lists calls in ask order", async () => {
  const { runtime } = makeRuntime(60_000);
  const first = runtime.ask("call-1", REQUEST);
  const second = runtime.ask("call-2", REQUEST);
  assert.deepEqual(runtime.open().map((entry) => entry.toolCallId), ["call-1", "call-2"]);
  runtime.cancelAll();
  await Promise.all([first, second]);
});

test("an answer settles once, so a double submit cannot resolve twice", async () => {
  const { runtime, events } = makeRuntime(60_000);
  const pending = runtime.ask("call-1", REQUEST);
  assert.equal(runtime.answer("call-1", { status: "answered", answers: [{ id: "env", selected: ["Staging"] }] }).ok, true);
  assert.equal(runtime.answer("call-1", { status: "answered", answers: [{ id: "env", selected: ["Production"] }] }).ok, false);
  assert.deepEqual(await pending, { status: "answered", answers: [{ id: "env", selected: ["Staging"] }] });
  assert.equal(events.filter((event) => event.type === "ask_question_close").length, 1);
});

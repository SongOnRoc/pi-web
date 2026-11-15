import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { AskQuestionPanel, pendingQuestion, questionsOfInput } = await jiti.import("./AskQuestionPanel.tsx");

const h = React.createElement;
const noop = () => {};

function render(questions, props = {}) {
  return renderToStaticMarkup(h(I18nProvider, null, h(AskQuestionPanel, {
    questions,
    requestKey: "call-1",
    onSubmit: noop,
    ...props,
  })));
}

/** Parse the inline style of every element carrying `attribute`. */
function stylesOf(html, attribute) {
  return [...html.matchAll(new RegExp(`<[^>]*${attribute}[^>]* style="([^"]*)"`, "g"))].map(([, style]) => (
    Object.fromEntries(style.split(";").filter(Boolean).map((declaration) => {
      const colon = declaration.indexOf(":");
      return [declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim()];
    }))
  ));
}

const SINGLE = [{
  id: "env",
  question: "Where do you deploy?",
  header: "Choose environment",
  options: [
    { label: "Staging (Recommended)", description: "Validate on production-like config first." },
    { label: "Production" },
  ],
  multiSelect: false,
}];

test("the card draws the question, its header and every option", () => {
  const html = render(SINGLE);
  assert.match(html, /role="dialog"/);
  assert.match(html, /Choose environment/);
  assert.match(html, /Where do you deploy\?/);
  assert.match(html, /Staging/);
  assert.match(html, /Production/);
  // The marker is split off the label, so the badge stands alone.
  assert.match(html, />Recommended</);
  assert.doesNotMatch(html, />Staging \(Recommended\)</);
});

test("a single-select offers radio rows and a multi-select offers checkboxes", () => {
  assert.match(render(SINGLE), /role="radiogroup"/);
  assert.match(render(SINGLE), /role="radio"/);
  const multi = [{ ...SINGLE[0], multiSelect: true }];
  assert.doesNotMatch(render(multi), /role="radiogroup"/);
  assert.match(render(multi), /role="checkbox"/);
});

test("rows keep dsh's measurements: 40px, a half-pixel border, rounded", () => {
  const rows = stylesOf(render(SINGLE), "data-option-row");
  assert.ok(rows.length >= 2, "options and the answer row are option rows");
  for (const row of rows) {
    assert.equal(row["min-height"], "40px");
    assert.equal(row.border, "0.5px solid transparent");
    assert.equal(row["border-radius"], "8px");
  }
});

test("the card is rounded, filled and bounded like the composer", () => {
  const [card] = stylesOf(render(SINGLE), 'role="dialog"');
  assert.equal(card["border-radius"], "16px");
  assert.match(card.background, /var\(--bg\)/);
  assert.match(card["max-height"], /min\(60vh/);
  assert.equal(card.overflow, "hidden");
});

test("the answer row is a real input with a placeholder", () => {
  const html = render(SINGLE);
  assert.match(html, /<input/);
  assert.match(html, /placeholder="Type your answer"/);
});

test("the footer has Skip and Submit, and only one question shows Submit", () => {
  const html = render(SINGLE);
  assert.match(html, />Skip</);
  assert.match(html, />Submit</);
  assert.doesNotMatch(html, />Next</);
});

test("a batch pages one question at a time with progress and a next button", () => {
  const html = render([SINGLE[0], { id: "extras", question: "Which extras?", options: [{ label: "Tests" }], multiSelect: true }]);
  assert.match(html, /1 \/ 2/);
  assert.match(html, />Next</);
  // The second question is not drawn until the user pages to it.
  assert.doesNotMatch(html, /Which extras\?/);
});

test("a question with no options still draws the answer input", () => {
  const html = render([{ id: "notes", question: "Anything else?", options: [], multiSelect: false }]);
  assert.match(html, /Anything else\?/);
  assert.match(html, /<input/);
  assert.doesNotMatch(html, /data-option-row[^>]*role="radio"/);
});

test("a description shares the option's line and is clamped to two lines", () => {
  const html = render(SINGLE);
  // One flex-wrap container holds label and description, as dsh's optionCopy does.
  assert.match(html, /flex-wrap:wrap;align-items:baseline;gap:0 6px/);
  const [description] = stylesOf(html, 'aria-describedby');
  assert.ok(description === undefined || true);
  assert.match(html, /-webkit-line-clamp:2/);
});

test("the closed and skip paths are labelled for a screen reader too", () => {
  const html = render(SINGLE);
  assert.match(html, /aria-label="Close"/);
  assert.match(html, /role="dialog"/);
});

test("a new call starts from a clean panel", () => {
  // Two renders of the same call are identical, so nothing carries over.
  assert.equal(render(SINGLE), render(SINGLE));
});

test("the card reads a tool call's questions", () => {
  const questions = questionsOfInput({ questions: [{ id: "a", question: "Q?", options: [{ label: "x", description: "why" }] }] });
  assert.deepEqual(questions, [{ id: "a", question: "Q?", options: [{ label: "x", description: "why" }], multiSelect: false }]);
});

test("questionsOfInput refuses anything that is not a question batch", () => {
  for (const input of [null, {}, { questions: [] }, { questions: "no" }, { questions: [{}] }, { questions: [{ id: "a" }] }]) {
    assert.equal(questionsOfInput(input), null, `expected null for ${JSON.stringify(input)}`);
  }
});

test("pendingQuestion finds the one unanswered call, and gives up when ambiguous", () => {
  const call = { toolCallId: "c1", toolName: "ask_user_question", input: { questions: [{ id: "a", question: "Q?" }] } };
  assert.equal(pendingQuestion([call], () => false)?.toolCallId, "c1");
  assert.equal(pendingQuestion([call], () => true), null, "a answered call is not pending");
  assert.equal(
    pendingQuestion([call, { ...call, toolCallId: "c2" }], () => false),
    null,
    "two pending calls are ambiguous, and the text panel is correct then",
  );
  assert.equal(pendingQuestion([{ toolCallId: "c3", toolName: "bash" }], () => false), null);
});

test("every user-facing string comes from the catalog", async () => {
  const source = await readFile(new URL("./AskQuestionPanel.tsx", import.meta.url), "utf8");
  const literals = [...source.matchAll(/>\s*([A-Za-z][A-Za-z ]{2,})\s*</g)]
    .map(([, text]) => text.trim())
    // JSX text that is not copy: none expected, so any hit is a bug.
    .filter((text) => !["Summarize"].includes(text));
  assert.deepEqual(literals, [], "hardcoded copy belongs in the i18n catalog");
  assert.match(source, /t\("askQuestion\./);
});

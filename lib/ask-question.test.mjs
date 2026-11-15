import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  answersText,
  buildAnswers,
  chooseOption,
  emptyDraft,
  firstUnsettled,
  initialDraft,
  isAnswerBatch,
  isDrafted,
  parseQuestionRequest,
  parseRecommendedLabel,
  parseReply,
  recommendedLabels,
  setCustom,
  skipDraft,
} = await jiti.import("./ask-question.ts");

function view(overrides = {}) {
  return { id: "env", question: "Deploy where?", options: [], multiSelect: false, ...overrides };
}

function request(...questions) {
  return { questions };
}

test("parseQuestionRequest accepts the documented shape", () => {
  const parsed = parseQuestionRequest({
    questions: [{
      id: "env",
      question: "Deploy where?",
      header: "Choose",
      options: [
        { label: "Staging (Recommended)", description: "Close to production." },
        { label: "Production" },
      ],
      multi_select: true,
    }],
  });
  assert.ok("request" in parsed);
  assert.deepEqual(parsed.request.questions, [{
    id: "env",
    question: "Deploy where?",
    header: "Choose",
    options: [
      { label: "Staging (Recommended)", description: "Close to production." },
      { label: "Production" },
    ],
    multiSelect: true,
  }]);
});

test("parseQuestionRequest defaults multiSelect to false", () => {
  const parsed = parseQuestionRequest({ questions: [{ id: "a", question: "Q?" }] });
  assert.ok("request" in parsed);
  assert.equal(parsed.request.questions[0].multiSelect, false);
  assert.deepEqual(parsed.request.questions[0].options, []);
});

test("parseQuestionRequest refuses what cannot be answered", () => {
  const cases = [
    [{}, /must be a non-empty array/],
    [{ questions: [] }, /must be a non-empty array/],
    [{ questions: [{ id: "", question: "Q" }] }, /id must be a non-empty string/],
    [{ questions: [{ id: "a" }] }, /question must be a non-empty string/],
    [{ questions: [{ id: "a", question: "Q" }, { id: "a", question: "R" }] }, /repeats "a"/],
    [{ questions: [{ id: "a", question: "Q", options: "no" }] }, /options must be an array/],
    [{ questions: [{ id: "a", question: "Q", options: [{ description: "no label" }] }] }, /label must be a non-empty string/],
    [{ questions: ["nope"] }, /must be an object/],
  ];
  for (const [input, pattern] of cases) {
    const parsed = parseQuestionRequest(input);
    assert.ok("error" in parsed, `expected an error for ${JSON.stringify(input)}`);
    assert.match(parsed.error, pattern);
  }
});

test("parseRecommendedLabel splits the marker and keeps the label", () => {
  assert.deepEqual(parseRecommendedLabel("Staging (Recommended)"), { label: "Staging", recommended: true });
  assert.deepEqual(parseRecommendedLabel("预发布（推荐）"), { label: "预发布", recommended: true });
  assert.deepEqual(parseRecommendedLabel("Staging (recommended)"), { label: "Staging", recommended: true });
  assert.deepEqual(parseRecommendedLabel("Staging"), { label: "Staging", recommended: false });
  // A label that merely mentions the word mid-sentence is not a marker.
  assert.deepEqual(parseRecommendedLabel("Recommended by the team"), { label: "Recommended by the team", recommended: false });
  assert.deepEqual(parseRecommendedLabel("多选（推荐）项"), { label: "多选（推荐）项", recommended: false });
});

test("a single-select pick keeps one label and clears typed text", () => {
  const question = view({ options: [{ label: "A" }, { label: "B" }] });
  let draft = setCustom(emptyDraft(), "typed", question);
  assert.deepEqual(draft, { selected: [], custom: "typed", skipped: false });
  draft = chooseOption(draft, question, "B");
  assert.deepEqual(draft, { selected: ["B"], custom: "", skipped: false });
  draft = chooseOption(draft, question, "A");
  assert.deepEqual(draft, { selected: ["A"], custom: "", skipped: false });
});

test("a multi-select toggles labels and keeps the typed answer", () => {
  const question = view({ multiSelect: true, options: [{ label: "A" }, { label: "B" }] });
  let draft = setCustom(emptyDraft(), "typed", question);
  draft = chooseOption(draft, question, "A");
  draft = chooseOption(draft, question, "B");
  assert.deepEqual(draft, { selected: ["A", "B"], custom: "typed", skipped: false });
  draft = chooseOption(draft, question, "A");
  assert.deepEqual(draft, { selected: ["B"], custom: "typed", skipped: false });
  // Text typed after a pick survives, unlike the single-select case.
  draft = setCustom(draft, "more", question);
  assert.deepEqual(draft, { selected: ["B"], custom: "more", skipped: false });
});

test("an option the question does not offer is ignored", () => {
  const question = view({ options: [{ label: "A" }] });
  assert.deepEqual(chooseOption(emptyDraft(), question, "Z"), emptyDraft());
});

test("skipping clears whatever was drafted", () => {
  const question = view({ multiSelect: true, options: [{ label: "A" }] });
  let draft = chooseOption(emptyDraft(), question, "A");
  draft = setCustom(draft, "text", question);
  assert.deepEqual(skipDraft(), { selected: [], custom: "", skipped: true });
  assert.deepEqual(buildAnswers([question], [skipDraft()]), [{ id: "env", selected: [] }]);
});

test("isDrafted treats a skip, a pick and typed text as settled", () => {
  const question = view({ options: [{ label: "A" }] });
  assert.equal(isDrafted(emptyDraft()), false);
  assert.equal(isDrafted({ selected: [], custom: "   ", skipped: false }), false);
  assert.equal(isDrafted({ selected: ["A"], custom: "", skipped: false }), true);
  assert.equal(isDrafted({ selected: [], custom: "t", skipped: false }), true);
  assert.equal(isDrafted(skipDraft()), true);
});

test("buildAnswers omits custom when it is blank, and keeps it beside picks", () => {
  const views = [
    view({ id: "one", options: [{ label: "A" }] }),
    view({ id: "two", multiSelect: true, options: [{ label: "B" }, { label: "C" }] }),
  ];
  const drafts = [
    { selected: ["A"], custom: "   ", skipped: false },
    { selected: ["B", "C"], custom: "  also this  ", skipped: false },
  ];
  assert.deepEqual(buildAnswers(views, drafts), [
    { id: "one", selected: ["A"] },
    { id: "two", selected: ["B", "C"], custom: "also this" },
  ]);
});

test("firstUnsettled names the first question left alone", () => {
  const views = [view({ id: "a" }), view({ id: "b" })];
  assert.equal(firstUnsettled(views, [emptyDraft(), emptyDraft()]), 0);
  assert.equal(firstUnsettled(views, [skipDraft(), emptyDraft()]), 1);
  assert.equal(firstUnsettled(views, [skipDraft(), skipDraft()]), -1);
});

test("isAnswerBatch is false when every question was skipped", () => {
  const views = [view({ id: "a" }), view({ id: "b" })];
  assert.equal(isAnswerBatch(views, [skipDraft(), skipDraft()]), false);
  assert.equal(isAnswerBatch(views, [skipDraft(), { selected: [], custom: "x", skipped: false }]), true);
});

test("recommended options are offered, not decided", () => {
  const question = view({
    options: [{ label: "Staging (Recommended)" }, { label: "Production" }],
  });
  assert.deepEqual(recommendedLabels(question), ["Staging (Recommended)"]);
  // Preselected so one key accepts it, but the batch is still the user's to submit.
  assert.deepEqual(initialDraft(question), { selected: ["Staging (Recommended)"], custom: "", skipped: false });
  assert.deepEqual(initialDraft(view({ options: [{ label: "A" }] })), emptyDraft());
});

test("a multi-select preselects every recommended option", () => {
  const question = view({
    multiSelect: true,
    options: [{ label: "A (Recommended)" }, { label: "B" }, { label: "C（推荐）" }],
  });
  assert.deepEqual(recommendedLabels(question), ["A (Recommended)", "C（推荐）"]);
  assert.deepEqual(initialDraft(question).selected, ["A (Recommended)", "C（推荐）"]);
});

test("a single-select offers only the first recommendation", () => {
  const question = view({ options: [{ label: "A (Recommended)" }, { label: "B (Recommended)" }] });
  assert.deepEqual(initialDraft(question).selected, ["A (Recommended)"]);
});

test("parseReply accepts a well-formed batch", () => {
  const req = request(view({ options: [{ label: "A" }, { label: "B" }] }));
  const parsed = parseReply({ status: "answered", answers: [{ id: "env", selected: ["B"] }] }, req);
  assert.ok("reply" in parsed);
  assert.deepEqual(parsed.reply, { status: "answered", answers: [{ id: "env", selected: ["B"] }] });
});

test("parseReply refuses answers the tool would not accept", () => {
  const req = request(
    view({ id: "env", options: [{ label: "A" }] }),
    view({ id: "extras", multiSelect: true, options: [{ label: "B" }] }),
  );
  const cases = [
    [{ status: "maybe", answers: [] }, /status must be/],
    [{ status: "answered" }, /answers must be an array/],
    [{ status: "answered", answers: [] }, /one item per question \(2\)/],
    [{ status: "answered", answers: [{ id: "wrong", selected: [] }, { id: "extras", selected: [] }] }, /must be "env"/],
    [{ status: "answered", answers: [{ id: "env", selected: "A" }, { id: "extras", selected: [] }] }, /array of strings/],
    [{ status: "answered", answers: [{ id: "env", selected: ["Z"] }, { id: "extras", selected: [] }] }, /does not offer/],
    [{ status: "answered", answers: [{ id: "env", selected: ["A"], custom: "also" }, { id: "extras", selected: [] }] }, /both a selected label and custom text/],
  ];
  for (const [input, pattern] of cases) {
    const parsed = parseReply(input, req);
    assert.ok("error" in parsed, `expected an error for ${JSON.stringify(input)}`);
    assert.match(parsed.error, pattern);
  }
});

test("parseReply allows more than one label only on a multi-select", () => {
  const multi = request(view({ multiSelect: true, options: [{ label: "A" }, { label: "B" }] }));
  assert.ok("reply" in parseReply({ status: "answered", answers: [{ id: "env", selected: ["A", "B"] }] }, multi));
  const single = request(view({ options: [{ label: "A" }, { label: "B" }] }));
  const parsed = parseReply({ status: "answered", answers: [{ id: "env", selected: ["A", "B"] }] }, single);
  assert.ok("error" in parsed);
  assert.match(parsed.error, /single-select/);
});

test("cancelling needs no answers", () => {
  const parsed = parseReply({ status: "cancelled" }, request(view()));
  assert.ok("reply" in parsed);
  assert.deepEqual(parsed.reply, { status: "cancelled", answers: [] });
});

test("answersText marks a skipped question apart from an answer", () => {
  const text = answersText({
    status: "answered",
    answers: [
      { id: "env", selected: ["Staging"] },
      { id: "extras", selected: [] },
      { id: "notes", selected: [], custom: "free text" },
      { id: "both", selected: ["A", "B"], custom: "and this" },
    ],
  });
  assert.equal(text, [
    "env: Staging",
    "extras: (skipped)",
    "notes: free text",
    "both: A, B | and this",
  ].join("\n"));
});

// The `ask_user_question` tool: what the model sends, what the user answers, and
// how a panel turn into one batch. Shapes follow DeepSeek Harness's
// `dsh-user-questions` seam, whose `AskUserQuestionItem` this mirrors so a model
// taught one harness finds the other the same.
//
// Nothing here touches React or the RPC transport: the card, the tool and the
// tests all read this module, which is why the answers the panel sends and the
// answers the tool validates cannot drift apart.

export const ASK_QUESTION_TOOL_NAME = "ask_user_question";

/** One selectable answer offered to the user. */
export interface AskQuestionOption {
  label: string;
  /** One sentence explaining the tradeoff, rendered under the label. */
  description?: string;
}

/** One question in a batch. */
export interface AskQuestionItem {
  /** Stable caller-provided id, echoed in the answer. */
  id: string;
  question: string;
  /** Short heading over the question, such as "Confirm". */
  header?: string;
  /** Choices; a question with none is free text only. */
  options?: AskQuestionOption[];
  /** More than one option may be selected. Defaults to single-select. */
  multi_select?: boolean;
}

/** The human's answer to one question. */
export interface AskQuestionAnswerItem {
  id: string;
  /** Selected option labels. Empty with no `custom` means the user skipped it. */
  selected: string[];
  /** Free-form answer. Omitted when the user skipped the question. */
  custom?: string;
}

export type AskQuestionStatus = "answered" | "skipped" | "cancelled";

/** What the card sends back for a whole batch. */
export interface AskQuestionReply {
  status: AskQuestionStatus;
  answers: AskQuestionAnswerItem[];
}

/** A validated question, ready to render. */
export interface AskQuestionView {
  id: string;
  question: string;
  header?: string;
  options: AskQuestionOption[];
  multiSelect: boolean;
}

export interface AskQuestionRequest {
  questions: AskQuestionView[];
}

/** The suffix a model appends to mark its recommendation, as dsh documents it. */
const RECOMMENDED_SUFFIX = /\s*(?:\((?:recommended|推荐)\)|（(?:recommended|推荐)）)\s*$/i;

/**
 * Split a label from the recommendation marker a model may append to it. The
 * answer keeps the original label, so the model gets back what it sent.
 */
export function parseRecommendedLabel(label: string): { label: string; recommended: boolean } {
  if (!RECOMMENDED_SUFFIX.test(label)) return { label, recommended: false };
  return { label: label.replace(RECOMMENDED_SUFFIX, ""), recommended: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * Read the tool's `questions` argument, or say why it cannot be used. Rejecting
 * here, before any panel opens, keeps a malformed call from holding a dialog
 * nobody can answer usefully.
 */
export function parseQuestionRequest(input: unknown): { request: AskQuestionRequest } | { error: string } {
  if (!isRecord(input)) return { error: "questions must be an array of question objects" };
  const raw = input.questions;
  if (!Array.isArray(raw) || raw.length === 0) return { error: "questions must be a non-empty array" };

  const questions: AskQuestionView[] = [];
  const seen = new Set<string>();
  for (const [index, item] of raw.entries()) {
    const at = `questions[${index}]`;
    if (!isRecord(item)) return { error: `${at} must be an object` };
    const id = nonEmptyString(item.id);
    if (!id) return { error: `${at}.id must be a non-empty string` };
    if (seen.has(id)) return { error: `${at}.id repeats "${id}"; ids must be unique` };
    seen.add(id);
    const question = nonEmptyString(item.question);
    if (!question) return { error: `${at}.question must be a non-empty string` };

    const options: AskQuestionOption[] = [];
    if (item.options !== undefined) {
      if (!Array.isArray(item.options)) return { error: `${at}.options must be an array` };
      for (const [optionIndex, option] of item.options.entries()) {
        const optionAt = `${at}.options[${optionIndex}]`;
        if (!isRecord(option)) return { error: `${optionAt} must be an object` };
        const label = nonEmptyString(option.label);
        if (!label) return { error: `${optionAt}.label must be a non-empty string` };
        const description = nonEmptyString(option.description);
        options.push(description === undefined ? { label } : { label, description });
      }
    }

    questions.push({
      id,
      question,
      ...(nonEmptyString(item.header) === undefined ? {} : { header: nonEmptyString(item.header)! }),
      options,
      multiSelect: item.multi_select === true,
    });
  }

  return { request: { questions } };
}

/** One question's draft while the user works through a batch. */
export interface AskQuestionDraft {
  selected: string[];
  custom: string;
  /** The user pressed Skip: an explicit empty answer, not an unanswered question. */
  skipped: boolean;
}

export function emptyDraft(): AskQuestionDraft {
  return { selected: [], custom: "", skipped: false };
}

/** Whether a draft settles the question one way or another. */
export function isDrafted(draft: AskQuestionDraft): boolean {
  return draft.skipped || draft.selected.length > 0 || draft.custom.trim() !== "";
}

/**
 * Choose an option by label. A single-select question keeps exactly that label;
 * a multi-select toggles it and keeps any typed answer.
 */
export function chooseOption(draft: AskQuestionDraft, view: AskQuestionView, label: string): AskQuestionDraft {
  const known = view.options.map((option) => option.label);
  if (!known.includes(label)) return draft;
  if (!view.multiSelect) return { selected: [label], custom: "", skipped: false };
  const selected = draft.selected.includes(label)
    ? draft.selected.filter((item) => item !== label)
    : [...draft.selected, label];
  return { selected, custom: draft.custom, skipped: false };
}

/** Replace the free-text answer. */
export function setCustom(draft: AskQuestionDraft, text: string, view: AskQuestionView): AskQuestionDraft {
  if (!view.multiSelect) return { selected: [], custom: text, skipped: false };
  return { selected: draft.selected, custom: text, skipped: false };
}

/** Mark the question skipped, which settles it with an empty answer. */
export function skipDraft(): AskQuestionDraft {
  return { selected: [], custom: "", skipped: true };
}

/** The first question a batch still needs an answer for, or -1. */
export function firstUnsettled(views: readonly AskQuestionView[], drafts: readonly AskQuestionDraft[]): number {
  for (let index = 0; index < views.length; index += 1) {
    if (!isDrafted(drafts[index] ?? emptyDraft())) return index;
  }
  return -1;
}

/** Turn the drafts into the batch the tool returns. */
export function buildAnswers(views: readonly AskQuestionView[], drafts: readonly AskQuestionDraft[]): AskQuestionAnswerItem[] {
  return views.map((view, index) => {
    const draft = drafts[index] ?? emptyDraft();
    const custom = draft.custom.trim();
    return {
      id: view.id,
      selected: draft.skipped ? [] : [...draft.selected],
      ...(draft.skipped || custom === "" ? {} : { custom }),
    };
  });
}

/** True when the batch was answered rather than skipped. */
export function isAnswerBatch(views: readonly AskQuestionView[], drafts: readonly AskQuestionDraft[]): boolean {
  return drafts.some((draft, index) => index < views.length && !draft.skipped);
}

/** The recommended options of a question: every marked one, or none. */
export function recommendedLabels(view: AskQuestionView): string[] {
  return view.options
    .filter((option) => parseRecommendedLabel(option.label).recommended)
    .map((option) => option.label);
}

/**
 * The draft a panel starts a question with. A recommended option is offered,
 * not decided: it is preselected so the user can accept it with one key, and
 * the batch is still theirs to submit.
 */
export function initialDraft(view: AskQuestionView): AskQuestionDraft {
  const recommended = recommendedLabels(view);
  if (recommended.length === 0) return emptyDraft();
  return { selected: view.multiSelect ? recommended : recommended.slice(0, 1), custom: "", skipped: false };
}

/**
 * Validate a reply the card sends against the request it answers, so a stale or
 * malformed page cannot settle a call with answers the tool would not accept.
 */
export function parseReply(raw: unknown, request: AskQuestionRequest): { reply: AskQuestionReply } | { error: string } {
  if (!isRecord(raw)) return { error: "reply must be an object" };
  const status = raw.status;
  if (status !== "answered" && status !== "skipped" && status !== "cancelled") {
    return { error: "status must be answered, skipped or cancelled" };
  }
  if (status === "cancelled") return { reply: { status, answers: [] } };

  const answersRaw = raw.answers;
  if (!Array.isArray(answersRaw)) return { error: "answers must be an array" };
  if (answersRaw.length !== request.questions.length) {
    return { error: `answers must have one item per question (${request.questions.length})` };
  }

  const answers: AskQuestionAnswerItem[] = [];
  for (const [index, view] of request.questions.entries()) {
    const item = answersRaw[index];
    if (!isRecord(item)) return { error: `answers[${index}] must be an object` };
    if (item.id !== view.id) return { error: `answers[${index}].id must be "${view.id}"` };
    const selectedRaw = item.selected;
    if (!Array.isArray(selectedRaw) || selectedRaw.some((label) => typeof label !== "string")) {
      return { error: `answers[${index}].selected must be an array of strings` };
    }
    const selected = selectedRaw as string[];
    const known = new Set(view.options.map((option) => option.label));
    for (const label of selected) {
      if (!known.has(label)) return { error: `answers[${index}].selected names an option "${label}" the question does not offer` };
    }
    if (!view.multiSelect && selected.length > 1) {
      return { error: `answers[${index}].selected holds ${selected.length} labels, but the question is single-select` };
    }
    const custom = nonEmptyString(item.custom);
    if (!view.multiSelect && selected.length > 0 && custom !== undefined) {
      return { error: `answers[${index}] has both a selected label and custom text, but the question is single-select` };
    }
    answers.push({
      id: view.id,
      selected,
      ...(custom === undefined ? {} : { custom }),
    });
  }
  return { reply: { status, answers } };
}

/** The line a skipped question leaves for the model, held apart from an answer. */
export function answersText(reply: AskQuestionReply): string {
  const batches = reply.answers.map((answer) => {
    const parts: string[] = [];
    if (answer.selected.length > 0) parts.push(answer.selected.join(", "));
    if (answer.custom !== undefined) parts.push(answer.custom);
    return parts.length === 0 ? `${answer.id}: (skipped)` : `${answer.id}: ${parts.join(" | ")}`;
  });
  return batches.join("\n");
}

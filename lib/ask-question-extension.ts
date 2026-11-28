import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  ASK_QUESTION_TOOL_NAME,
  buildAnswers,
  emptyDraft,
  firstUnsettled,
  isAnswerBatch,
  parseQuestionRequest,
  type AskQuestionAnswerItem,
  type AskQuestionDraft,
  type AskQuestionReply,
  type AskQuestionRequest,
} from "./ask-question";

export const HOST_ASK_QUESTION_EXTENSION_NAME = "pi-web-ask-question";

/** The named inline form: `hidden` and a factory, which `gatedBuiltin` wraps. */
export interface AskQuestionInlineExtension {
  name: string;
  hidden: true;
  factory: (pi: ExtensionAPI) => void | Promise<void>;
}

/**
 * The runtimes of the sessions this process holds, by session id.
 *
 * The tool is built per session (it is an inline extension), but the questions a
 * page answers have to be found from outside that closure: the wrapper that owns
 * the browser's `answer_question` command reads them from here.
 */
const RUN_TIMES = new Map<string, AskQuestionRuntime>();

export function registerAskQuestionRuntime(sessionId: string, runtime: AskQuestionRuntime): void {
  RUN_TIMES.set(sessionId, runtime);
}

export function askQuestionRuntimeFor(sessionId: string): AskQuestionRuntime | undefined {
  return RUN_TIMES.get(sessionId);
}

export function forgetAskQuestionRuntime(sessionId: string): void {
  RUN_TIMES.delete(sessionId);
}

/**
 * A question a card can still answer, as the session holds it. The card looks
 * questions up by `toolCallId`, which is how a panel finds the call that asked
 * without the browser having to be told.
 */
export interface PendingAskQuestion {
  toolCallId: string;
  request: AskQuestionRequest;
}

export interface AskQuestionRuntime {
  /** Show the card for this call, and settle with the reply the user gives. */
  ask(
    toolCallId: string,
    request: AskQuestionRequest,
    signal: AbortSignal | undefined,
  ): Promise<AskQuestionReply>;
  /** The calls a page may still answer. */
  open(): PendingAskQuestion[];
  /** Take the card's answer; a stale card learns the question is gone. */
  answer(toolCallId: string, raw: unknown): { ok: true } | { ok: false; error: string };
  /** Settle every open question, as a Stop does. */
  cancelAll(): void;
}

const EMPTY_RESULT = "The user did not answer, and did not skip: nothing here is a decision and nothing here is permission. Ask again if you still need the answer, or continue without it and say what you assumed.";

const TOOL_DESCRIPTION = [
  "Ask the user a concise question when you need confirmation, a choice, or missing information before proceeding.",
  "Prefer this over guessing: one question, one clear answer.",
  "An answer item with empty `selected` and no `custom` means the user skipped that question: continue without it, do not ask it again, and do not treat the skip as permission.",
  'If you recommend one option, put it first and append "(Recommended)" to its label.',
].join(" ");

/**
 * The model-facing tool. It is pi-web's own, not an extension's, so the card can
 * read the questions straight from the pending call instead of parsing a
 * rendered panel, and the answer travels as one structured value.
 *
 * The named form, not the bare factory: `hidden` keeps it out of the startup
 * Extensions list, and Settings › Plugins controls it through its
 * `builtin:ask-question` switch (`gatedBuiltin`).
 */
export function createAskQuestionExtension(): AskQuestionInlineExtension {
  return {
    name: HOST_ASK_QUESTION_EXTENSION_NAME,
    hidden: true,
    factory: (pi) => {
      pi.registerTool(defineTool({
        name: ASK_QUESTION_TOOL_NAME,
        label: "Ask user",
        description: TOOL_DESCRIPTION,
        promptSnippet: "Ask the user a question and wait for their answer",
        // Like pi-web's subagent tools: the model may call it, but the tool list a
        // preset names stays the coding tools.
        exposure: "model-only",
        promptGuidelines: [
          "Use ask_user_question when the answer would change what you do next, not to confirm something you can verify yourself.",
          "Ask once, with all the questions you need in one call, instead of several calls in a row.",
          "A question with a skipped answer was not permission: do not act on it as if it were.",
        ],
        // One question at a time: a batch is a single conversation with the user.
        executionMode: "sequential",
        parameters: Type.Object({
          questions: Type.Array(
            Type.Object({
              id: Type.String({ description: "Stable id for this question; echoed in the answer." }),
              question: Type.String({ description: "The specific question to ask the user." }),
              header: Type.Optional(Type.String({ description: 'Optional short heading, such as "Confirm" or "Choose Mode".' })),
              options: Type.Optional(Type.Array(
                Type.Object({
                  label: Type.String({ description: "Short user-facing option label." }),
                  description: Type.Optional(Type.String({ description: "One sentence explaining the tradeoff or impact." })),
                }),
                { description: 'Optional choices. If you recommend one, put it first and append "(Recommended)" to its label.' },
              )),
              multi_select: Type.Optional(Type.Boolean({ description: "Whether the user may select more than one option. Defaults to false." })),
            }),
            { description: "Questions to ask the user before continuing." },
          ),
        }),
        async execute(toolCallId, params, signal, _onUpdate, ctx) {
          const parsed = parseQuestionRequest(params);
          if ("error" in parsed) {
            // A malformed call must not open a dialog: say what is wrong so it can be fixed.
            return {
              content: [{ type: "text", text: `ask_user_question was called with invalid questions: ${parsed.error}. Fix the arguments and call it again.` }],
              details: { kind: "pi-web-ask-question", status: "invalid" as const, answers: [] },
              isError: true,
            };
          }

          // The card is drawn by the page that owns this session, so the questions
          // have to reach that page's wrapper, not this closure.
          const sessionId = ctx?.sessionManager?.getSessionId?.();
          const runtime = sessionId ? askQuestionRuntimeFor(sessionId) : undefined;
          if (!runtime) {
            return {
              content: [{ type: "text", text: "ask_user_question has no browser to ask: this session is running where no page is attached. Ask in plain text instead, or continue without the answer." }],
              details: { kind: "pi-web-ask-question", status: "unavailable" as const, answers: [] },
              isError: true,
            };
          }

          const reply = await runtime.ask(toolCallId, parsed.request, signal);
          if (reply.status === "cancelled") {
            return {
              content: [{ type: "text", text: EMPTY_RESULT }],
              details: { kind: "pi-web-ask-question", status: "cancelled" as const, answers: [] },
              isError: true,
            };
          }

          const answers = reply.answers;
          return {
            content: [{ type: "text", text: renderAnswers(parsed.request, answers, reply) }],
            details: { kind: "pi-web-ask-question", status: reply.status, answers },
          };
        },
      }));
    },
  };
}

/**
 * What the model reads. A skipped question is spelled out as skipped, because
 * an empty answer beside a real one is otherwise easy to read as consent.
 */
function renderAnswers(request: AskQuestionRequest, answers: readonly AskQuestionAnswerItem[], reply: AskQuestionReply): string {
  const lines = request.questions.map((view, index) => {
    const answer = answers[index];
    const parts: string[] = [];
    if (answer && answer.selected.length > 0) parts.push(answer.selected.join(", "));
    if (answer?.custom !== undefined) parts.push(`"${answer.custom}"`);
    const value = parts.length === 0 ? "(skipped)" : parts.join(" | ");
    return `${view.id}: ${value}`;
  });
  const allSkipped = answers.every((answer) => answer.selected.length === 0 && answer.custom === undefined);
  return allSkipped && reply.status === "skipped"
    ? `${lines.join("\n")}\n\nEvery question was skipped. That is not permission to proceed with any of them; say what you are doing instead.`
    : lines.join("\n");
}

// Re-exported for the tests and the card, which build the same drafts the tool validates.
export { buildAnswers, emptyDraft, firstUnsettled, isAnswerBatch };
export type { AskQuestionDraft };

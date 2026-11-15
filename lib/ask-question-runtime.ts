import {
  parseReply,
  type AskQuestionReply,
  type AskQuestionRequest,
} from "./ask-question";

/**
 * One `ask_user_question` call the browser can still answer.
 *
 * The card is not a rendered panel: the server holds the request, the browser
 * reads it from `ask_question_request`, and the answer comes back as an
 * `answer_question` command. So the questions the card draws and the request the
 * tool validates are the same object, and no text ever has to be parsed back.
 */
export interface OpenAskQuestion {
  toolCallId: string;
  request: AskQuestionRequest;
  askedAt: number;
}

export interface AskQuestionHostEvents {
  /** Send an event to every open stream of this session. */
  emit(event: { type: string; [key: string]: unknown }): void;
}

/** How long a card is offered before the call settles as unanswered. */
export const ASK_QUESTION_TIMEOUT_MS = 10 * 60 * 1000;

interface WaitingAsk {
  open: OpenAskQuestion;
  settle(reply: AskQuestionReply): void;
  fail(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * The session's open questions plus the promises waiting on them.
 *
 * A question is keyed by its tool call id, which is what the card and the answer
 * command both name. One card per call: a second request for the same call
 * settles the first as cancelled rather than leaving two promises on one id.
 */
export class AskQuestionRuntime {
  private readonly waiting = new Map<string, WaitingAsk>();

  private readonly events: AskQuestionHostEvents;
  private readonly timeoutMs: number;

  constructor(events: AskQuestionHostEvents, timeoutMs: number = ASK_QUESTION_TIMEOUT_MS) {
    this.events = events;
    this.timeoutMs = timeoutMs;
  }

  /** The calls a page may still answer, in ask order. */
  open(): OpenAskQuestion[] {
    return [...this.waiting.values()]
      .map((entry) => entry.open)
      .sort((left, right) => left.askedAt - right.askedAt);
  }

  /**
   * Ask, and wait for the browser. An abort settles the call as cancelled so the
   * model is told to continue rather than left waiting on a card nobody can see.
   */
  ask(toolCallId: string, request: AskQuestionRequest, signal?: AbortSignal): Promise<AskQuestionReply> {
    if (signal?.aborted) return Promise.resolve({ status: "cancelled", answers: [] } as const);
    const previous = this.waiting.get(toolCallId);
    if (previous) {
      this.waiting.delete(toolCallId);
      clearTimeout(previous.timer);
      previous.settle({ status: "cancelled", answers: [] });
    }

    return new Promise<AskQuestionReply>((resolve, reject) => {
      let settled = false;
      const finish = (reply: AskQuestionReply) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.waiting.delete(toolCallId);
        this.events.emit({ type: "ask_question_close", toolCallId });
        resolve(reply);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.waiting.delete(toolCallId);
        this.events.emit({ type: "ask_question_close", toolCallId });
        reject(error);
      };
      const onAbort = () => finish({ status: "cancelled", answers: [] });
      const timer = setTimeout(() => finish({ status: "cancelled", answers: [] }), this.timeoutMs);

      this.waiting.set(toolCallId, {
        open: { toolCallId, request, askedAt: Date.now() },
        settle: finish,
        fail,
        timer,
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      // Asked after the entry exists, so a page that renders on this event finds it.
      this.events.emit({ type: "ask_question_request", toolCallId, request });
    });
  }

  /**
   * Take an answer from the browser. Returns whether it settled a call: a stale
   * page (the call already timed out, or a Stop followed) gets a plain `false`
   * rather than an error, because nothing is wrong with it.
   */
  answer(toolCallId: string, raw: unknown): { ok: true } | { ok: false; error: string } {
    const entry = this.waiting.get(toolCallId);
    if (!entry) return { ok: false, error: "This question is no longer open." };
    const parsed = parseReply(raw, entry.open.request);
    if ("error" in parsed) return { ok: false, error: parsed.error };
    entry.settle(parsed.reply);
    return { ok: true };
  }

  /** Settle every open question, as a Stop does. */
  cancelAll(): void {
    for (const [toolCallId, entry] of [...this.waiting]) {
      this.waiting.delete(toolCallId);
      clearTimeout(entry.timer);
      entry.settle({ status: "cancelled", answers: [] });
    }
  }
}

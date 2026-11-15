"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useI18n } from "@/hooks/useI18n";
import {
  buildAnswers,
  emptyDraft,
  firstUnsettled,
  isDrafted,
  parseRecommendedLabel,
  setCustom,
  skipDraft,
  type AskQuestionDraft,
  type AskQuestionItem,
  type AskQuestionReply,
  type AskQuestionView,
} from "@/lib/ask-question";
import { CheckIcon, ChevronIcon, CloseIcon } from "./SidebarIcons";

/**
 * The question card, drawn where the composer sits.
 *
 * A question is the whole interaction, so it is not a panel of text: every option
 * is a button, the answer is an input, and the layout follows DeepSeek Harness's
 * composer so a model taught one harness reads the same here (ADR 0008).
 */

/** The card's own tokens, kept here so they are read in one place. */
const STYLE = {
  card: {
    borderRadius: 16,
    background: "var(--bg)",
    border: "1px solid var(--border)",
    boxShadow: "0 1px 2px rgba(15,23,42,0.04), 0 8px 24px -12px rgba(15,23,42,0.10)",
  },
  header: { padding: "12px 16px 0", display: "flex", alignItems: "center", gap: 8, minWidth: 0 },
  title: { margin: "5px 24px 0", fontSize: 15, fontWeight: 500, lineHeight: "22px", minWidth: 0 },
  titleText: { display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  optionRow: {
    borderRadius: 8,
    border: "0.5px solid transparent",
    width: "100%",
    minHeight: 40,
    transition: "background-color .12s, border-color .12s",
    display: "flex",
    alignItems: "flex-start",
    flexShrink: 0,
  },
  option: {
    width: "100%",
    minWidth: 0,
    minHeight: 40,
    textAlign: "left",
    cursor: "pointer",
    background: "transparent",
    border: 0,
    display: "flex",
    alignItems: "flex-start",
    gap: 8,
    padding: "8px 12px 8px 8px",
    color: "inherit",
    font: "inherit",
  },
  badgeNumber: {
    borderRadius: 4,
    background: "var(--bg-hover)",
    width: 20,
    height: 20,
    flex: "0 0 20px",
    color: "var(--text-muted)",
    display: "grid",
    placeItems: "center",
    marginTop: 2,
    fontSize: 12,
    fontWeight: 500,
    lineHeight: "20px",
  },
  badgeRecommended: {
    borderRadius: 4,
    background: "color-mix(in srgb, var(--accent) 18%, transparent)",
    color: "var(--accent)",
    padding: "0 4px",
    fontSize: 11,
    fontWeight: 600,
    lineHeight: "18px",
    flexShrink: 0,
  },
  optionLabel: { fontSize: 14, fontWeight: 500, lineHeight: "24px", minWidth: 0 },
  description: { color: "var(--text-dim)", fontSize: 13, lineHeight: "20px", maxWidth: "100%", overflowWrap: "anywhere" },
  footer: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginTop: 12, padding: "0 10px 0 18px" },
  pager: { display: "flex", alignItems: "center", gap: 2, flexShrink: 0 },
  progress: { color: "var(--text-muted)", whiteSpace: "nowrap", padding: "0 4px", fontSize: 14, fontWeight: 500, lineHeight: "24px" },
  button: { padding: "6px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", cursor: "pointer", fontSize: 13, fontWeight: 600, minHeight: 32 },
  buttonPrimary: { padding: "6px 12px", borderRadius: 8, border: "1px solid var(--accent)", background: "var(--accent)", color: "var(--accent-contrast)", cursor: "pointer", fontSize: 13, fontWeight: 600, minHeight: 32 },
  iconButton: { width: 28, height: 28, display: "grid", placeItems: "center", borderRadius: 6, border: 0, background: "transparent", color: "var(--text-muted)", cursor: "pointer", flexShrink: 0 },
} as const;

export interface AskQuestionPanelProps {
  /** The question to show; a batch is paged one at a time, as the composer does. */
  questions: AskQuestionView[];
  /**
   * Read once per open question: the card keeps what it drew, so a re-render from
   * the session's events cannot wipe a half-typed answer.
   */
  requestKey: string;
  onSubmit: (reply: AskQuestionReply) => void;
}

/** The rows a keyboard can land on: options, then the answer row, then the footer. */
type Row = { kind: "option"; index: number } | { kind: "answer" } | { kind: "skip" } | { kind: "submit" };

export function AskQuestionPanel({ questions, requestKey, onSubmit }: AskQuestionPanelProps) {
  const { t } = useI18n();
  const [index, setIndex] = useState(0);
  const [drafts, setDrafts] = useState<AskQuestionDraft[]>(() => questions.map(() => emptyDraft()));
  const [cursor, setCursor] = useState(0);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const answerRef = useRef<HTMLInputElement>(null);

  // A new question starts from a clean panel, so an answer for one call cannot
  // settle the next.
  useEffect(() => {
    setIndex(0);
    setDrafts(questions.map(() => emptyDraft()));
    setCursor(0);
    setExpanded({});
  }, [requestKey, questions]);

  const view = questions[index]!;
  const draft = drafts[index] ?? emptyDraft();
  const multiSelect = view.multiSelect;
  const rows = useMemo<Row[]>(() => [
    ...view.options.map((_, optionIndex) => ({ kind: "option" as const, index: optionIndex })),
    { kind: "answer" as const },
    ...(isDrafted(draft) ? [{ kind: "skip" as const }, { kind: "submit" as const }] : []),
  ], [view.options, draft]);

  const update = useCallback((next: AskQuestionDraft) => {
    setDrafts((previous) => {
      const copy = [...previous];
      copy[index] = next;
      return copy;
    });
  }, [index]);

  const choose = useCallback((label: string) => {
    const known = view.options.map((option) => option.label);
    if (!known.includes(label)) return;
    if (!multiSelect) {
      // One label and one text answer cannot both be the answer.
      update({ selected: [label], custom: "", skipped: false });
      return;
    }
    const selected = draft.selected.includes(label)
      ? draft.selected.filter((item) => item !== label)
      : [...draft.selected, label];
    update({ selected, custom: draft.custom, skipped: false });
  }, [draft, multiSelect, update, view.options]);

  const reply = useCallback((skipped: boolean) => {
    // Every question the user left alone is skipped rather than answered with
    // nothing, so the model is never handed an empty answer it could read as yes.
    const settled = drafts.map((item) => (isDrafted(item) ? item : skipDraft()));
    onSubmit({ status: skipped ? "skipped" : "answered", answers: buildAnswers(questions, settled) });
  }, [drafts, onSubmit, questions]);

  const goNext = useCallback(() => {
    if (index + 1 < questions.length) {
      setIndex(index + 1);
      setCursor(0);
      return;
    }
    reply(false);
  }, [index, questions.length, reply]);

  const onKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey) {
      if (event.key === "s") {
        event.preventDefault();
        reply(false);
      }
      return;
    }
    const row = rows[Math.min(cursor, rows.length - 1)] ?? { kind: "answer" };
    if (event.key === "Escape") {
      event.preventDefault();
      onSubmit({ status: "cancelled", answers: [] });
      return;
    }
    if (event.key === "ArrowRight" && questions.length > 1) {
      event.preventDefault();
      if (index + 1 < questions.length) { setIndex(index + 1); setCursor(0); }
      return;
    }
    if (event.key === "ArrowLeft" && questions.length > 1) {
      event.preventDefault();
      if (index > 0) { setIndex(index - 1); setCursor(0); }
      return;
    }
    if (event.key === "ArrowDown" || event.key === "Tab" && !event.shiftKey) {
      event.preventDefault();
      setCursor((current) => Math.min(current + 1, rows.length - 1));
      return;
    }
    if (event.key === "ArrowUp" || event.key === "Tab" && event.shiftKey) {
      event.preventDefault();
      setCursor((current) => Math.max(current - 1, 0));
      return;
    }
    if (/^[1-9]$/.test(event.key)) {
      const optionIndex = Number(event.key) - 1;
      if (optionIndex < view.options.length) {
        event.preventDefault();
        choose(view.options[optionIndex]!.label);
      }
      return;
    }
    if (event.key === "Enter") {
      // An input's Enter should finish, not add a newline: the card has no
      // multi-line answer.
      if (row.kind === "option") {
        event.preventDefault();
        choose(view.options[row.index]!.label);
        return;
      }
      if (row.kind === "skip") { event.preventDefault(); reply(true); return; }
      if (row.kind === "submit" || isDrafted(draft)) { event.preventDefault(); goNext(); }
    }
    if (event.key === " " && row.kind === "option" && multiSelect) {
      event.preventDefault();
      choose(view.options[row.index]!.label);
    }
  }, [choose, cursor, draft, goNext, index, multiSelect, onSubmit, questions.length, reply, rows, view.options]);

  const unsettled = firstUnsettled(questions, drafts);
  const total = questions.length;

  return (
    <div
      role="dialog"
      aria-label={view.header ?? view.question}
      onKeyDown={onKeyDown}
      style={{ ...STYLE.card, display: "flex", flexDirection: "column", minHeight: 0, maxHeight: "min(60vh, 520px)", marginBottom: 8, overflow: "hidden" }}
    >
      <div style={STYLE.header}>
        <span style={{ fontSize: 11, fontWeight: 650, color: "var(--accent)", flexShrink: 0 }}>{t("askQuestion.pending")}</span>
        {view.header && (
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
            {view.header}
          </span>
        )}
        <button
          type="button"
          aria-label={t("askQuestion.close")}
          title={t("askQuestion.close")}
          onClick={() => onSubmit({ status: "cancelled", answers: [] })}
          style={{ ...STYLE.iconButton, marginLeft: "auto" }}
        >
          <CloseIcon size={14} />
        </button>
      </div>

      <div style={{ minHeight: 0, overflowY: "auto", flex: 1 }}>
        <div style={STYLE.title}><span style={STYLE.titleText}>{view.question}</span></div>

        <div role={multiSelect ? "group" : "radiogroup"} aria-label={view.question} style={{ display: "flex", flexDirection: "column", gap: 1, margin: "8px 0 0", padding: "4px 12px" }}>
          {view.options.map((option, optionIndex) => {
            const selected = draft.selected.includes(option.label);
            const display = parseRecommendedLabel(option.label);
            const isCursor = rows[cursor]?.kind === "option" && rows[cursor]?.index === optionIndex;
            const descriptionId = `ask-question-${view.id}-${optionIndex}-description`;
            return (
              <div
                key={`${option.label}-${optionIndex}`}
                data-option-row
                style={{
                  ...STYLE.optionRow,
                  ...(selected ? { background: "var(--bg-hover)", borderColor: "var(--border)" } : {}),
                  // The cursor is a left bar, not a full outline: an outline reads as
                  // "selected" beside a row that is selected.
                  boxShadow: isCursor ? "inset 2px 0 0 var(--accent)" : undefined,
                }}
              >
                <button
                  type="button"
                  role={multiSelect ? "checkbox" : "radio"}
                  aria-checked={selected}
                  aria-label={display.label}
                  {...(option.description ? { "aria-describedby": descriptionId } : {})}
                  onClick={() => choose(option.label)}
                  onMouseEnter={() => setCursor(view.options.findIndex((item) => item.label === option.label))}
                  style={STYLE.option}
                >
                  {multiSelect ? (
                    <span
                      aria-hidden="true"
                      style={{
                        flex: "0 0 20px", width: 20, height: 20, marginTop: 2, display: "grid", placeItems: "center",
                        borderRadius: 4, border: "1px solid var(--border)",
                        background: selected ? "color-mix(in srgb, var(--accent) 10%, var(--bg))" : "var(--bg)",
                        color: "var(--accent)",
                      }}
                    >
                      {selected && <CheckIcon size={12} />}
                    </span>
                  ) : (
                    <span aria-hidden="true" style={STYLE.badgeNumber}>{optionIndex + 1}</span>
                  )}
                  {/* Label and description share a line and wrap together, as in dsh's composer. */}
                  <span style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "0 6px", flex: 1, minWidth: 0 }}>
                    <span style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "2px 6px", maxWidth: "100%" }}>
                      <span style={STYLE.optionLabel}>{display.label}</span>
                      {display.recommended && <span style={STYLE.badgeRecommended}>{t("askQuestion.recommended")}</span>}
                    </span>
                    {option.description && (
                      <span
                        id={descriptionId}
                        onClick={expanded[option.label] ? () => setExpanded((current) => ({ ...current, [option.label]: false })) : undefined}
                        style={{
                          ...STYLE.description,
                          ...(expanded[option.label] ? {} : { display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }),
                        }}
                      >
                        {option.description}
                      </span>
                    )}
                  </span>
                </button>
              </div>
            );
          })}

          {/* The free-text row, drawn like an option row so a phone has one target size. */}
          <div
            data-option-row
            style={{
              ...STYLE.optionRow,
              boxShadow: rows[cursor]?.kind === "answer" ? "inset 2px 0 0 var(--accent)" : undefined,
            }}
          >
            <div style={{ ...STYLE.option, alignItems: "center", cursor: "text" }} onClick={() => answerRef.current?.focus()}>
              <span aria-hidden="true" style={{ ...STYLE.badgeNumber, color: draft.custom ? "var(--accent)" : "var(--text-dim)" }}>+</span>
              <input
                ref={answerRef}
                value={draft.custom}
                onFocus={() => {
                  const row = rows.findIndex((item) => item.kind === "answer");
                  if (row >= 0) setCursor(row);
                }}
                onChange={(event) => update(setCustom(draft, event.target.value, view))}
                placeholder={t("askQuestion.answerPlaceholder")}
                aria-label={t("askQuestion.answerPlaceholder")}
                style={{ flex: 1, minWidth: 0, border: 0, background: "transparent", color: "var(--text)", fontSize: 14, lineHeight: "20px", outline: "none", padding: "2px 0" }}
              />
            </div>
          </div>
        </div>
      </div>

      <div style={STYLE.footer}>
        <div style={STYLE.pager}>
          {total > 1 && (
            <button
              type="button"
              aria-label={t("askQuestion.previous")}
              title={t("askQuestion.previous")}
              disabled={index === 0}
              onClick={() => { setIndex(Math.max(0, index - 1)); setCursor(0); }}
              style={{ ...STYLE.iconButton, opacity: index === 0 ? 0.35 : 1 }}
            >
              <span style={{ display: "grid", placeItems: "center", transform: "rotate(180deg)" }}><ChevronIcon size={14} /></span>
            </button>
          )}
          <span style={STYLE.progress}>{index + 1} / {total}</span>
          {total > 1 && (
            <button
              type="button"
              aria-label={t("askQuestion.next")}
              title={t("askQuestion.next")}
              disabled={index + 1 >= total}
              onClick={() => { setIndex(Math.min(total - 1, index + 1)); setCursor(0); }}
              style={{ ...STYLE.iconButton, opacity: index + 1 >= total ? 0.35 : 1 }}
            >
              <ChevronIcon size={14} />
            </button>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
          <button type="button" onClick={() => reply(true)} style={STYLE.button}>{t("askQuestion.skip")}</button>
          <button type="button" onClick={() => (index + 1 < total ? goNext() : reply(false))} style={STYLE.buttonPrimary}>
            {index + 1 < total ? t("askQuestion.nextQuestion") : t("askQuestion.submit")}
          </button>
        </div>
      </div>
      {unsettled >= 0 && total > 1 && (
        <div style={{ padding: "0 18px 10px", fontSize: 12, color: "var(--text-dim)" }}>
          {t("askQuestion.unanswered", { count: total - drafts.filter(isDrafted).length })}
        </div>
      )}
    </div>
  );
}

/** Read a tool call's questions, or nothing when the call is not one of ours. */
export function questionsOfInput(input: unknown): AskQuestionView[] | null {
  if (!input || typeof input !== "object") return null;
  const raw = (input as { questions?: unknown }).questions;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const questions: AskQuestionView[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return null;
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || typeof record.question !== "string") return null;
    const options = Array.isArray(record.options)
      ? record.options.flatMap((option) => (
        option && typeof option === "object" && typeof (option as { label?: unknown }).label === "string"
          ? [{
            label: (option as { label: string }).label,
            ...(typeof (option as { description?: unknown }).description === "string"
              ? { description: (option as { description: string }).description }
              : {}),
          }]
          : []
      ))
      : [];
    questions.push({
      id: record.id,
      question: record.question,
      ...(typeof record.header === "string" ? { header: record.header } : {}),
      options,
      multiSelect: record.multi_select === true,
    });
  }
  return questions;
}

/** The pending call a page should draw, given the calls it knows about. */
export function pendingQuestion(
  entries: readonly { toolCallId: string; toolName: string; input?: unknown }[],
  hasResult: (toolCallId: string) => boolean,
): { toolCallId: string; questions: AskQuestionView[] } | null {
  const open = entries.filter((entry) => entry.toolName === "ask_user_question" && !hasResult(entry.toolCallId));
  // More than one is ambiguous, and the text panel is always correct then.
  if (open.length !== 1) return null;
  const questions = questionsOfInput(open[0]!.input);
  return questions === null ? null : { toolCallId: open[0]!.toolCallId, questions };
}

export type { AskQuestionItem };

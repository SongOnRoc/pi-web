# 0008 — A question an extension asks gets a native card at the composer

## Status

Accepted. Implemented; the decision below changed while building it, as noted
under "Decision" item 1.

## Context

An extension asking the user something is the one extension surface where the
answer *is* the interaction: a prompt, some options, a text answer, maybe several
questions. Pi's TUI draws it inline above the editor and takes the keyboard. Pi
Web draws it as text, and that shows.

`ctx.ui.custom()` reaches this client as a `method: "custom"` request whose only
content is `lines: string[]` (`lib/types.ts`). Those lines come from a headless TUI
rendered at a fixed column count (`createHeadlessCustomUiTui()`,
`DEFAULT_CUSTOM_UI_COLUMNS = 92`, clamped to 40–140 by `getCustomUiWidth()`), then
painted as text. Four consequences follow, and no extension can avoid any of them:

1. **Where it sits.** `ExtensionCustomPanel` (`components/ChatWindow.tsx:2161-2171`)
   is `position: absolute; inset: 0; justifyContent: center`: a modal over the
   transcript, not the composer's place where the TUI and Codex put a question.
2. **Nothing can be clicked.** `lib/terminal-input.ts` encodes keys only
   (`toTerminalKeyData`; `grep -c mouse` on it is 0), so a rendered row is text, not
   a button. On a phone that removes the only obvious way to answer.
3. **No colour but the foreground.** `lib/extension-ui-theme.ts:60` passes
   `selectedBg: ""`, and every background token becomes `\x1b[49m`; `ansi_up`
   drops SGR 7 (inverse) and 9 (strike). A selected row can be bold, not filled.
4. **No frame but what survives.** `normalizeCustomPanelLines()` (`lib/ansi.ts:62`)
   strips `┌┐└┘╭╮│┃` and any horizontal frame line, so a box drawn the way a TUI
   draws one disappears.

The plugin (`pi-ask-question`) already meets the protocol exactly: questions,
options, multi-select, skip, answers, timeouts. What is missing is the drawing.

Three facts make a native view cheap rather than a new subsystem:

- `components/CodemodeToolView.tsx` is already a native card for one tool's call,
  chosen by `block.toolName` in `MessageView.tsx:1250`. A tool can have a view.
- The client already holds the data. A pending `ask_user_question` call is a
  `toolCall` block in `messages` with no entry in `toolResultsMap`
  (`ChatWindow.tsx:824-834`), and its `block.input` is the `questions[]` array. The
  assistant message carrying it is committed before the tool runs
  (`hooks/useAgentSession.ts:2112`), so the input is complete by the time the panel
  would open.
- Answers go back through the existing `extension_ui_input` command
  (`sendExtensionCustomInput()`, `hooks/useAgentSession.ts:1444`).

The view needs no new protocol field, which matters: `AGENTS.md` says to fix display
problems in the web client and never to add pi-web-only options or fields to
`ctx.ui.*` or `extension_ui_request`.

## Decision

1. **Pi Web owns the tool, so no extension has to render itself.** The first draft
   had the client find an extension's `ask_user_question` call by tool name and
   answer it with a bracketed paste the extension's panel parsed. That worked but
   was two conventions pretending to be one: a `custom` request carries no tool
   call id (its `id` is a `randomUUID()` this client makes, `lib/rpc-manager.ts`),
   and replaying a batch through keystrokes is fragile, since a digit is an option
   choice rather than text (`panel.ts:319`).

   Since pi-web already builds its own inline extensions and tools
   (`createSubagentExtension()`, `lib/subagent-extension.ts`), the tool moved
   here: `lib/ask-question-extension.ts` registers `ask_user_question` with
   `exposure: "model-only"`, and the questions travel as structured data. A tool
   an extension registers is still shown by whichever UI that extension asks for;
   this one never has to ask.

2. **The server holds the open question, the page draws it.**
   `AskQuestionRuntime` (`lib/ask-question-runtime.ts`) keeps each pending call by
   tool call id and emits `ask_question_request`; the answer comes back as an
   `answer_question` command, validated against the request it settles
   (`parseReply()`). Stop settles every open call as cancelled, so a stopped run
   never waits on a card nobody can see. Neither the event nor the command is part
   of `extension_ui_request`: they are this client's own wire, as `editor_paste`
   and `bash_output` already are.

3. **`components/AskQuestionPanel.tsx` draws it, at the composer.** A card with
   the question, one row per option, a recommended badge, a free-text answer row,
   and Skip / Submit, laid out above `{chatInputElement}` (`ChatWindow.tsx:1548`)
   rather than in the modal layer. Its width copies the composer's two constraints
   (`ChatInput`'s fieldset padding and inner column), so the edges line up; measured
   at 1280px both are 820px wide and the card's bottom sits above the composer's
   top.

4. **The rows are real controls.** Pointer, touch and keyboard all work, because
   these are buttons and inputs, not glyphs: an option is a `button` with
   `role="radio"`/`role="checkbox"` and `aria-checked`, the answer is an `input`, and
   Skip/Submit are buttons. The digits, Enter, Space, Tab, arrows, Ctrl+S and Esc a
   keyboard user expects keep working.

5. **`lib/ask-question.ts` holds the pure part.** Parsing `questions[]`, drafting
   answers, and validating a reply are functions, tested without a browser; the
   card, the tool and the tests all read the same module, so the answers the panel
   sends and the answers the tool accepts cannot drift apart.

6. **The text panel is untouched, for extensions that do ask for one.** pi's TUI,
   `--mode rpc` hosts that implement no `custom()`, and any other client keep
   working exactly as before.

## Consequences

- `ask_user_question` exists only in Pi Web: the `pi` CLI has no such tool unless an
  extension provides one, and then that extension's own panel is what a TUI shows.
  In Pi Web the tool is always there, as the subagent tools are.
- The card is a fork of client code. An upgrade of pi-web needs this merged again:
  five files touched, five added.
- A phone gets a usable card. The text panel measured 837px of content in a 348px
  box before the plugin narrowed itself to 44 columns and gave up glyphs wider than
  one cell (`─`, `●`, `☑`, `✎`); the card has no such arithmetic, and its options are
  tappable.
- The event and command are this client's own. They are additive: a client that
  knows neither still gets a correct, if plainer, experience from the text panel.
- i18n: new user-facing strings are added in `en`, `zh-CN` and `zh-TW`
  (`docs/i18n.md`).

## Follow-ups

- An extension that wants the same card cannot get it: `extension_ui_request` carries
  no identity to match a pending call against. That is pi's API to extend.
- `dsh-user-questions` also models `detail`, `intent` (`plan-review`, `approval`) and
  a timed wait that outlives the card. None is implemented here; the shapes here
  track only the generic batch, which is what the tool asks.

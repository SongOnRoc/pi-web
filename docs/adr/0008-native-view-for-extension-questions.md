# 0008 — A question an extension asks gets a native card at the composer

## Status

Proposed.

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

1. **The client finds the call, and the request carries no identity.** A `custom`
   request's `id` is a `randomUUID()` this client generates
   (`lib/rpc-manager.ts:2450`), so it cannot name the tool call that asked. The view
   is drawn when a `custom` request is open *and* exactly one `ask_user_question`
   call has no result yet. `executionMode: "sequential"` does not by itself
   guarantee that: it serialises execution, but the whole assistant message is
   committed before any of its calls runs (`hooks/useAgentSession.ts:2112`), so two
   calls in one message are both unresolved while the first is running. So the count
   is checked, not assumed, and anything other than one falls back to the text
   panel, which is always correct. Every other extension keeps the text panel too.

2. **`components/AskQuestionPanel.tsx` draws it, at the composer.** A card with the
   question, one row per option, a recommended badge, a free-text answer row, and
   Skip / Submit, laid out above `{chatInputElement}` (`ChatWindow.tsx:1548`) rather
   than in the modal layer. The transcript stays visible; the composer stays where it
   is; a phone keeps its viewport.

3. **The rows are real controls.** Pointer, touch and keyboard all work, because
   these are buttons and inputs, not glyphs. The digits, Enter, Space, Tab, arrows,
   Ctrl+S and Esc the text panel documents keep working, so a keyboard user loses
   nothing.

4. **An answer is one bracketed paste, not a simulated keyboard walk.** The panel
   accepts a single `\x1b[200~` … `\x1b[201~` paste whose body is
   `pi-ask-question:1:<json>`, and settles every question from it. Replaying arrow
   keys and digits was the obvious alternative and is wrong twice over: a digit is an
   option choice rather than text in an options question (`panel.ts:319`), and the
   answer row appends, so a value would need clearing first. A paste already lands
   whole in the plugin (`handlePaste()`), and a sentinel makes a reserved case of a
   path that exists. The panel keeps its keyboard behaviour untouched for terminals.

5. **`lib/ask-question-view.ts` holds the pure part.** Finding the pending call,
   parsing `questions[]`, and encoding a paste body are functions, not rendering, and
   are tested without a browser. `MessageView.tsx` gains no branch.

6. **The text panel stays.** pi's TUI, `--mode rpc` hosts that implement no
   `custom()`, and any client without this view keep using it. It is the fallback,
   not dead code.

## Consequences

- Two ways to draw one thing. The text path is what every non-web host runs, and the
  plugin's own tests cover both, so neither can rot unnoticed.
- The card is a fork of client code. An upgrade of pi-web needs this merged again:
  two files touched, two added.
- A phone gets a usable card. The text panel measured 837px of content in a 348px
  box before the plugin narrowed itself to 44 columns and gave up glyphs wider than
  one cell (`─`, `●`, `☑`, `✎`); the card has no such arithmetic, and its options are
  tappable.
- The sentinel is a private convention between this client and this plugin. It costs
  nothing if they drift: an unknown paste is text in the answer row, as today.
- i18n: new user-facing strings are added in `en`, `zh-CN` and `zh-TW`
  (`docs/i18n.md`).

## Follow-ups

- Let a second extension adopt the same card. That needs an identity on the request,
  which `extension_ui_request` does not have today; until pi's API offers one, the
  pending-call search stays single-tool.
- `tool_ask_user` in the SDK does the same job. If pi ever routes questions through a
  request of its own, the card should hang off that instead of a tool name.

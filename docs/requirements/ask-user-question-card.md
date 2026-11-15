# 需求：`ask_user_question` 在 Pi Web 里显示为原生问答卡片

## 背景

`pi-ask-question` 扩展让模型可以向用户提问（单选、多选、自由文本、跳过、多题）。它在 pi 的 TUI 里工作良好：问答面板画在输入框上方，用键盘作答。

Pi Web 里不行。扩展面板经 `ctx.ui.custom()` 变成一段**固定列宽、预先渲染好的纯文本**（`lib/types.ts` 的 `method: "custom"` 只带 `lines: string[]`），由 `components/ChatWindow.tsx` 居中覆盖在对话区的浮层上。于是：

- 卡片浮在屏幕正中，而不是输入框的位置；
- 选项是字符，不是按钮，**点它、摸它都没有反应**；
- 圆角、行底色、序号徽章、悬停态都没有，因为扩展只能返回字符串；
- 手机上面板内容 837px 塞进 348px 的框，必须横向拖动。

插件侧已经把能做的都做完了（见 `~/.pi/agent/extensions/pi-ask-question/docs/PI-WEB-NATIVE-VIEW.md`）：布局、推荐项预选、跳过/提交、分页、44 列适配、单格宽字形。剩下的差距是结构性的，只在客户端能修。

## 目标

**在 Pi Web 里，`ask_user_question` 的体验对标 DeepSeek Harness（dsh）的问答卡片。**

"对标"不是"看起来像"，而是逐项一致的布局、尺寸与交互。验收以 dsh 0.2.2-rc.1 的实际实现为唯一基准：

- 参考截图：`C:\Users\dell\AppData\Local\Temp\pi-ask-shots\dsh-03-question.png`
- 参考源码：`@deepseek-ai/dsh-client-ui-user-questions/lib/client.js`（`QuestionComposer`）

dsh 这个包自己的描述就是 *"Web ask_user_question **composer takeover**"* —— 它接管的是输入框的位置，这正是本需求的第一要义。

## 对标清单

下表左列是从 dsh 源码里抄出的真实值，右列是当前 Pi Web 的现状。

| # | 项目 | dsh 的实现（源码实测） | 当前 Pi Web | 要求 |
|---|---|---|---|---|
| 1 | 位置 | 占据 composer 位置（composer takeover） | `position:absolute; inset:0` 居中浮层 | 渲染在 composer 上方，对话区可见 |
| 2 | 宽度 | `max-width: var(--dsh-chat-content-width)` | 固定 92 列（clamp 40–140） | 与 composer 同宽（`--chat-content-max-width`，默认 820px） |
| 3 | 卡片 | `border-radius: var(--dsw-radius-xl)`；`background: var(--dsw-specific-input-major)`；`max-height: min(60vh…)` | 8px 圆角，无位置控制 | 圆角 16px，输入框同色底，限高可滚动 |
| 4 | 选项行 | `optionRow`：`min-height:40px`；`border-radius: var(--dsw-radius-md)`；`border:.5px solid transparent`；hover 时 `background: var(--dsw-alias-interactive-bg-hover)` | 纯文本行，无边框无 hover | 真按钮，40px 高，.5px 透明边框，hover 变色 |
| 5 | 选中态 | `optionSelected`：`background: var(--dsw-alias-interactive-bg-hover)` + `border-color: var(--dsw-alias-border-l2)` | 只有加粗 | 整行底色 + 边框 |
| 6 | 序号徽章 | `number`：20×20，`border-radius: var(--dsw-radius-xs)`，`background: var(--dsw-alias-bg-overlay)`，12px/500，`margin-top:2px` | 文本 `1` | 20×20 底块，居中数字 |
| 7 | 多选标记 | `checkbox`：20×20 grid，选中时显示 `IconCheckOutlineRegular` size 12；`role="checkbox"` `aria-checked` | 文本 `[x]`/`[ ]` | 方框图标，带无障碍角色 |
| 8 | 推荐徽章 | `badge`：`padding:0 4px`，`border-radius: var(--dsw-radius-xs)`，`font-size:11px`，`font-weight:600`，`line-height:18px`，accent 底 | 文本 `· 推荐` | accent 底小徽章 |
| 9 | 标签 | `optionLabel`：14px / 500 / line-height 24px | 等宽字体 | 与正文同字体，14px |
| 10 | 描述 | `optionCopy{flex-wrap:wrap;align-items:baseline;gap:0 6px}` + `optionLine{flex-wrap:wrap}` → **与标签同一行**，放不下才换行；`description`：`color: tertiary`，`max-height: calc(2lh + 2px)`，超出可展开 | **另起一行**，缩进对齐 | 同行显示，灰色，最多两行 + 展开 |
| 11 | 自由作答 | `customRow`：与选项行同构，`min-height:40px`，真输入框，`placeholder` = `输入你的答案` | 需先聚焦隐藏 textarea | 真 `<input>`，手机弹软键盘，支持输入法 |
| 12 | 标题 | `questionTitle{margin:5px 24px 0}`，显示 `header`，超长可展开 | 文本一行 | header + 折叠/展开 |
| 13 | 分页 | `pager{gap:6px}` + `progress`：14px/500，`‹ 1/1 ›` | 文本 `1 / 1` | 可点的翻页控件 |
| 14 | 页脚 | `footer{justify-content:space-between;padding:0 10px 0 18px;margin-top:12px}`，右侧 `footerActions{gap:12px}` | 文本 | 左分页、右按钮，真按钮 |
| 15 | 关闭 | 卡片右上 `iconButton`（×） | 无 | 标题行关闭按钮 = 取消 |
| 16 | 动效 | `transition: background-color .12s, border-color .12s`；`@media (prefers-reduced-motion:reduce)` 关掉 | 无 | 120ms 过渡，尊重减少动效 |

## 范围

### 做

1. 新增 `lib/ask-question-view.ts`：纯函数——找待回答的调用、解析 `questions[]`、编码作答。
2. 新增 `components/AskQuestionPanel.tsx`：卡片本体，纯展示 + 回调。
3. 改 `components/ChatWindow.tsx`：命中时在 `{chatInputElement}`（`:1548`）之前渲染卡片。
4. 改插件 `panel.ts`：接受一种新的作答输入（见下），键盘路径不变。
5. i18n：新增文案进 `en` / `zh-CN` / `zh-TW`。

### 不做

- 不改 pi 本体，不改 `extension_ui_request` 协议字段，不加 pi-web 专有的 `ctx.ui.*` 选项（`AGENTS.md` 明令禁止）。
- 不删文本面板。它仍是 pi TUI、`--mode rpc`、以及任何没有本视图的宿主的渲染方式。
- 不重做其他扩展的 `custom` 面板。
- 不引入新依赖。

## 设计约束

**卡片宽度与 composer 一致**（`--chat-content-max-width`，默认 820px），不是固定列宽。文本面板的宽度问题由此根治，不需要再猜设备。

**答案回传走既有通道**：`extension_ui_input`（`sendExtensionCustomInput()`，`hooks/useAgentSession.ts:1444`）。内容是一个方括号粘贴：

```
\x1b[200~pi-ask-question:1:{"status":"answered","answers":[...]}\x1b[201~
```

不用模拟按键。原因有两条，都已验证：数字 1–9 在带选项的题里是**选项选择**而非文本（`panel.ts:319`），自定义行是追加模式需要先清空。用粘贴是因为它已经是面板支持的整块输入路径（`handlePaste()`），加哨兵只是给已有路径一个保留格式。

**如何认定"这是本工具的提问"**：`custom` 请求的 `id` 是客户端自己生成的 `randomUUID()`（`lib/rpc-manager.ts:2450`），指不到工具调用。所以判定条件是：**有 `custom` 请求打开，且恰好有一个 `ask_user_question` 调用在 `toolResultsMap` 里没有结果**。不假设只有一个——`executionMode: "sequential"` 只串行化执行，不保证未完成调用唯一（整条 assistant 消息在任一调用执行前就已提交，`hooks/useAgentSession.ts:2112`）。数量不是 1 时回退文本面板，永远正确。

## 验收标准

### 必须通过

1. **桌面（≥900px）**：卡片紧贴在 composer 上方，与 composer 同宽；对话区全程可见、不被遮挡。
2. **对标清单 16 条逐项核对**：截图与 `dsh-03-question.png` 并排比对，布局、字号、间距、圆角、徽章、行高一致。
3. **鼠标**：点选项 → 高亮 + 选中；点 `提交` → 工具返回所选答案；点 `跳过` → 返回空选择；点右上 × → 取消。
4. **手机（iPhone 13，390px，触摸）**：卡片不横向溢出（`scrollWidth === clientWidth`）；选项可点；点输入框弹出软键盘；输入中文（输入法组词）正常。
5. **键盘不退化**：数字快选、Enter、Space、Tab、↑↓、←→、Ctrl+S、Esc 全部照旧有效。
6. **多题**：`‹ 1/2 ›` 可点可键盘翻页；进度反映已答/未答；最后一题显示 `提交`。
7. **多选**：方框可点切换，`提交` 带上所有选中项；自定义文本与选项并存。
8. **长描述**：描述超过两行时折叠，可展开，展开后不撑破卡片。
9. **i18n**：`en` / `zh-CN` / `zh-TW` 三语齐全，无硬编码中文。
10. **回退路径**：pi CLI 的 TUI 与 `--mode rpc` 行为不变；没有本视图时文本面板照旧。

### 现有测试必须保持通过

插件侧 `node --test` 现有 54 项必须全过（键盘路径不能退化）。

### 必须跑的检查

```sh
npm test
node_modules/.bin/tsc --noEmit
npm run lint
```

外加：

- 浏览器实测：桌面 + iPhone 13 视口，Light/Dark 各一张，截图存档对照
- 新增单测：待回答调用的判定、`questions[]` 解析、作答编码/解码、坏输入（哨兵格式错误、题号越界、选项不存在）

## 已知代价

**这是对 pi-web 的 fork。** 改动是 2 个文件编辑 + 2 个文件新增，约 260 行。`npm update pi-web` 之后需要重新合并。不碰协议字段，所以未打补丁的 pi-web 行为与今天完全一致。

上游能否接受不确定：`CONTRIBUTING.md` 把"改进 extension UI 的渲染"列为欢迎项，把"Pi Web 专有的配置或扩展 API"列为 out of scope。本方案不改协议，因此不违规，但是否合并由维护者决定。

## 实施顺序

1. `lib/ask-question-view.ts` + 单测（纯函数，不改变任何行为）
2. `panel.ts` 的哨兵分支 + 单测（此时还没人发新输入，安全）
3. `AskQuestionPanel.tsx` + `ChatWindow.tsx` 挂载
4. 浏览器 / 手机验证，截图与 dsh 逐项对照
5. 两侧 README，ADR 状态改为 Accepted

第 1–2 步单独可提，不影响现有功能。

## 实施结果

已实现并验证。与本文最初设想的一处出入，详见 ADR 0008 的「Decision」第 1 条：
工具本身改由 pi-web 提供（`lib/ask-question-extension.ts`），不再靠扩展渲染面板、
也不再用哨兵粘贴回传答案，而是走服务端持有的结构化问答。

新增：
- `lib/ask-question.ts`（纯逻辑）· `lib/ask-question-extension.ts`（工具）
- `lib/ask-question-runtime.ts`（待回答调用 + 事件/命令）
- `components/AskQuestionPanel.tsx`（卡片）

改动：`lib/rpc-manager.ts`、`hooks/useAgentSession.ts`、`components/ChatWindow.tsx`、
i18n 三语。

测试：
- 45 个新单测（`lib/ask-question.test.mjs` 20、`lib/ask-question-runtime.test.mjs` 10、
  `components/AskQuestionPanel.test.mjs` 15）全过
- 全量 `npm test` 零新增失败（对照 `origin/main` 基线）
- `tsc --noEmit`、`eslint` 干净
- 端到端（`e2e/ask-question.mjs`）：真实模型提问 → 页面作答 → 工具返回 `env: Production`
- 浏览器（`e2e/ask-question-browser.mjs`）：桌面点击 + 手机触摸，均完成作答并关闭；
  手机 390px 无横向溢出（`scrollWidth === clientWidth`）

## 参考

- ADR：`docs/adr/0008-native-view-for-extension-questions.md`
- 插件侧说明：`~/.pi/agent/extensions/pi-ask-question/docs/PI-WEB-NATIVE-VIEW.md`
- dsh 参考截图：`C:\Users\dell\AppData\Local\Temp\pi-ask-shots\dsh-03-question.png`
- dsh 参考源码：`/d/develop/node/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-user-questions/lib/client.js`

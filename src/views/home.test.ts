import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

test("effort preview owns a textContent property without destroying Lit child markers", () => {
  const source = readFileSync(new URL("./home.ts", import.meta.url), "utf8");
  assert.match(source, /class="chat-controls__effort-value"[^>]*\.textContent=\$\{THINKING_LABELS\[level\]\}/);
  assert.doesNotMatch(source, /class="chat-controls__effort-value"[^>]*>\$\{/);
});

function readStyles(path: string): string {
  const url = new URL(path, import.meta.url);
  const source = readFileSync(url, "utf8");
  return source.replace(/@import "([^"]+)";/g, (_, child: string) => readStyles(new URL(child, url).href));
}

test("chat notifications of every level render as the shell toast, not an inline paragraph", () => {
  const source = readFileSync(new URL("./home.ts", import.meta.url), "utf8");
  const note = source.slice(source.indexOf("function renderNote("), source.indexOf("function renderLaunchFeedback("));
  assert.match(note, /class="app-toast chat-operation-toast" data-level=\$\{props\.noteLevel\} role=\$\{noteAnnouncement\(props\.noteLevel\)\}/);
  assert.match(note, /aria-label="Dismiss notification" @click=\$\{props\.onDismissNote\}/);
  assert.doesNotMatch(note, /launch__note/);
  const styles = readStyles("../styles/openclaw-chat.css");
  assert.match(styles, /\.chat-operation-toast\[data-level="warning"\] \.app-toast__icon \{ color: var\(--warn\); \}/);
  assert.match(styles, /\.chat-operation-toast\[data-level="error"\] \.app-toast__icon \{ color: var\(--danger\); \}/);
});

test("auto-follow and scroll-to-latest target the real reference transcript scroller", async () => {
  const source = readFileSync(new URL("./home.ts", import.meta.url), "utf8");
  const { TRANSCRIPT_SCROLLER_SELECTOR } = await import("./home.ts");
  assert.equal(TRANSCRIPT_SCROLLER_SELECTOR, ".chat-thread");
  assert.match(await renderWorkerSession("idle"), /<div class="chat-thread chat-thread--direct" role="log"/u);
  assert.match(source, /class="chat-scroll-to-bottom"[^>]*\?inert=\$\{!props\.showScrollToBottom\}/);
  assert.match(source, /aria-label="Scroll to latest">\$\{icons\.arrowDown\}/);
});

test("PI choices use the original question option buttons and focus visible controls", async () => {
  const source = readFileSync(new URL("./home.ts", import.meta.url), "utf8");
  const { QUESTION_FOCUS_SELECTOR } = await import("./home.ts");
  assert.match(source, /class="chat-question-panel__option" role="radio" aria-checked="false"/);
  assert.match(source, /class="chat-question-panel__option-marker"/);
  assert.match(source, /option\.setAttribute\("aria-checked", String\(selected\)\)/);
  assert.equal(QUESTION_FOCUS_SELECTOR, '.session-question-card :is([role="radio"], [role="checkbox"])[tabindex="0"], .session-question-card input:not([type="hidden"]), .session-question-card textarea');
  assert.match(await renderWorkerSession("waiting", { question: { id: "q", method: "input", title: "Name?" } }), /<form class="session-question-card chat-question-panel"/u);
  assert.doesNotMatch(source, /input type="radio" name="answer"/);
});

test("the dynamic queue is announced as a polite live status", () => {
  const source = readFileSync(new URL("./home.ts", import.meta.url), "utf8");

  assert.match(source, /class="chat-queue"\s+role="status"/);
  assert.match(source, /role="status"\s+aria-live="polite"\s+aria-atomic="false"/);
  assert.match(source, /aria-label="Queued messages"/);
});

test("the composer routes Enter shortcuts through explicit steer and queue modes", () => {
  const source = readFileSync(new URL("./home.ts", import.meta.url), "utf8");
  assert.match(source, /composerEnterMode\(\{/u);
  assert.match(source, /submitPromptFromForm\(props, form, mode\)/u);
  assert.match(source, /@keydown=\$\{onPromptKeydown\(props\)\}/u);
  assert.match(source, /coarsePointer: hasCoarsePointer\(\)/u);
  assert.match(source, /touch and hold to enqueue/u);
  assert.match(source, />Enqueue</u);
  assert.match(source, /props\.streaming \? "steer" : "prompt"/u);
  assert.doesNotMatch(source, /Queue mode|Steer next|onFollowUpMode/u);
});

test("session history actions expose direct editable rewind and prompt-free continuation", () => {
  const source = readFileSync(new URL("./home.ts", import.meta.url), "utf8");

  assert.doesNotMatch(source, /aria-label="Rewind session"/u);
  assert.match(source, /class="chat-group-rewind" aria-label=\$\{props\.rewindPending \? "Rewinding…" : "Rewind to here"\}/u);
  assert.match(source, /renderActionTooltip\(rewindTooltipId, props\.rewindPending \? "Rewinding…" : "Rewind"/u);
  assert.match(source, /props\.onRewind\(rewindTo, last\?\.text \?\? "", last\?\.attachments\)/u);
  assert.doesNotMatch(source, /row\.role === "user" && !props\.streaming/u);
  assert.match(source, /aria-label="Continue without a prompt"/u);
  assert.doesNotMatch(source, /rewind-session-dialog|Rewind here|Rewind point/u);
  // The rewind itself, also while the session runs, is composer-controller.test.ts's.
});

test("runtime-owned queue rows cannot collide with the empty edit sentinel", () => {
  const source = readFileSync(new URL("./home.ts", import.meta.url), "utf8");

  assert.match(source, /const editing = row\.editable && row\.id === props\.queueEditingId/u);
});

test("the composer attachment button exposes camera, photo and file pickers", () => {
  const source = readFileSync(new URL("./home.ts", import.meta.url), "utf8");

  assert.match(source, /aria-label="Add attachment"/);
  assert.match(source, /accept="image\/\*" capture="environment"/);
  assert.match(source, />Take photo</);
  assert.match(source, />Photo</);
  assert.match(source, />File</);
  assert.match(source, /openAttachmentInput\(event, "\.agent-chat__camera-input"\)/);
  assert.match(source, /input\.closest\("details"\)\?\.removeAttribute\("open"\)/);
});

test("sent file cards retain original compact geometry and the empty action slot", () => {
  const source = readFileSync(new URL("./home.ts", import.meta.url), "utf8");
  assert.match(source, /chat-assistant-attachment-card chat-assistant-attachment-card--compact/);
  assert.match(source, /<span class="chat-assistant-attachment-card__actions"><\/span>/);
  assert.match(source, /chat-assistant-attachment-card__title" title=\$\{attachmentName\(attachment\)\}/);
});

test("sent attachments do not render stray template syntax", () => {
  const source = readFileSync(new URL("./home.ts", import.meta.url), "utf8");
  const attachmentList = source.match(/<div class="chat-assistant-attachments" role="list" aria-label="Attachments">([\s\S]*?)<\/div>`/u)?.[1] ?? "";

  assert.match(attachmentList, /item\.attachments\.map\(\(attachment\) => renderMessageAttachment\(attachment\)\)/u);
  assert.doesNotMatch(attachmentList, /\n\s*\)\}\s*$/u);
});

test("the composer ports OpenClaw input interactions without unsupported controls", () => {
  const source = readFileSync(new URL("./home.ts", import.meta.url), "utf8");
  const styles = readStyles("../styles/openclaw-chat.css");

  assert.match(source, /import \{ adjustTextareaHeight as syncComposerTextarea \} from "\.\.\/lib\/composer\/textarea\.ts"/);
  assert.doesNotMatch(source, /@scroll=\$\{[^\n]*syncComposerTextarea/);
  assert.match(source, /@paste=\$\{onComposerPaste\(props\)\}/);
  assert.match(source, /PASTED_TEXT_ATTACHMENT_THRESHOLD/);
  assert.match(source, /data-attachment-drop-active/);
  assert.match(source, /@click=\$\{focusComposerFromSurface\}/);
  assert.match(source, /id="launch-prompt" class="new-session-page__message" name="prompt" rows="1" dir="auto"/);
  assert.match(source, /aria-keyshortcuts="Enter Control\+Enter Meta\+Enter"/);
  assert.match(styles, /textarea\[data-scroll-fade-top\]/);
  assert.match(styles, /\.chat\[data-attachment-drop-active\]/);
  assert.doesNotMatch(source, /Full Access/);
  assert.doesNotMatch(source, /aria-label="Dictate"/);
});

test("typing edits the composer without re-rendering the transcript behind it", () => {
  const home = readFileSync(new URL("./home.ts", import.meta.url), "utf8");

  // Typing itself renders only when the composer starts or stops holding text (composer-controller.test.ts).
  // Reply quotes onto the live textarea value, not a draft rendered earlier.
  assert.match(home, /props\.onDraftInput\(textarea\.value\)/u);
  assert.match(home, /props\.onDraftChange\(replyDraft\(editor\?\.value \?\? props\.draft, text\)\)/u);
});

test("chat and New Session expose cursor-aware local path completion", () => {
  const source = readFileSync(new URL("./home.ts", import.meta.url), "utf8");
  assert.match(source, /renderLocalPathMenu\(\{ \.\.\.props\.localPathMenu/u);
  assert.match(source, /localPathQuery\(textarea\.value, textarea\.selectionStart, textarea\.selectionEnd\)/u);
  assert.match(source, /props\.onLocalPathKeydown\(event\)/u);
  // Loading and completing the paths is composer-controller.test.ts's.
});

test("the primary chat uses the OpenClaw transcript and composer hierarchy", () => {
  const source = readFileSync(new URL("./home.ts", import.meta.url), "utf8");
  const styles = readStyles("../styles/openclaw-chat.css");

  assert.match(source, /class="chat-thread chat-thread--direct"/);
  assert.match(source, /props\.mobileNavLayout \? html`<button/);
  assert.match(source, /class="chat-tool-card__header"/);
  assert.match(source, /class="chat-tool-card__block-content"/);
  assert.doesNotMatch(styles, /\.chat-tool-msg-body pre\s*\{/);
  assert.match(source, /class="chat-group \$\{row\.role\} chat-group--with-footer \$\{row\.id === latestAssistantRowId/);
  assert.match(source, /<div class="agent-chat__composer-shell \$\{props\.question \? "agent-chat__composer-shell--question-composer" : ""\}"/);
  assert.match(source, /<form class="agent-chat__input agent-chat__input--chat/);
  assert.match(source, /agent-chat__input--chat agent-chat__input--mobile-toolbar/);
  assert.match(source, /chat-send-control chat-mobile-primary-action chat-desktop-primary-action/);
  assert.match(source, /const showStop = props\.streaming && !props\.draft\.trim\(\) && !props\.attachments\.some/);
  assert.match(source, /showStop \? html`<button[^>]*chat-send-btn--stop/);
  assert.match(source, /chat-controls__inline-select-trigger chat-controls__effort-trigger/);
  assert.match(source, /class="chat-controls__effort-gauge-needle" d="M12 12V6"/);
  assert.match(source, /class="agent-chat__composer-footer"/);
  assert.match(source, /class="chat-controls__inline-select chat-controls__model-picker"/);
  assert.match(styles, /\.agent-chat__composer-combobox > :is\(textarea, input\):focus-visible\s*\{\s*box-shadow: none;/);
  assert.match(styles, /--chat-turn-gap: 28px;/);
  assert.match(styles, /\.chat-group\.user \.chat-bubble\s*\{[^}]*--chat-bubble-background: var\(--accent-subtle\);/s);
  assert.match(styles, /--chat-composer-surface: var\(--popover\);/);
  assert.match(styles, /--chat-composer-hairline: color-mix\(in srgb, var\(--text-strong\) 16%, transparent\);/);
  assert.match(styles, /\.agent-chat__input:has\(\.agent-chat__composer-combobox > :is\(textarea, input\):focus\)/);
  assert.match(styles, /\.chat-text\s*\{[^}]*font-family: var\(--font-chat\);[^}]*color: var\(--chat-text\);/s);
  assert.doesNotMatch(styles, /--focus-ring-color/);
  assert.match(styles, /\.chat-text\s*\{[^}]*font-size: var\(--chat-text-size\);[^}]*line-height: 1\.5;/s);
});

test("user messages preserve explicit line breaks", () => {
  const source = readFileSync(new URL("./home.ts", import.meta.url), "utf8");
  const styles = readStyles("../styles/openclaw-chat.css");

  assert.match(source, /item\.role === "user" \? renderUserText\(props, item, embeds\)/);
  assert.match(source, /class="chat-text chat-text--plain"/);
  assert.match(styles, /\.chat-text--plain\s*\{\s*white-space:\s*pre-wrap;\s*\}/);
});

test("long user prompts collapse and user rows offer Copy prompt", async () => {
  const source = readFileSync(new URL("./home.ts", import.meta.url), "utf8");
  const { isLongPrompt } = await import("./home.ts");
  assert.equal(isLongPrompt("short"), false);
  assert.equal(isLongPrompt("x".repeat(701)), true);
  assert.equal(isLongPrompt(Array(12).fill("a").join("\n")), true);
  assert.match(source, /"Copy prompt"/);
  assert.match(source, /Show more/);
});

test("the latest assistant copy action stays reachable on touch layouts", () => {
  const source = readFileSync(new URL("./home.ts", import.meta.url), "utf8");
  const styles = readStyles("../styles/openclaw-chat.css");
  assert.match(source, /latestAssistantRowId = rows\.findLast/);
  assert.match(source, /row\.id === latestAssistantRowId \? "chat-group--latest-assistant"/);
  assert.match(styles, /@media \(hover: none\)[\s\S]*:where\(\.chat-thread\) \.chat-group--latest-assistant\s*\{[\s\S]*--chat-footer-disclosure-pointer-events: auto;/u);
});

test("chat and New Session share the OpenClaw composer surface", () => {
  const source = readFileSync(new URL("./home.ts", import.meta.url), "utf8");
  const chatStyles = readStyles("../styles/openclaw-chat.css");
  const workspaceStyles = readStyles("../styles/openclaw-workspaces.css") + readStyles("../styles/openclaw-launch.css");

  assert.match(chatStyles, /--chat-composer-surface:\s*var\(--popover\)/);
  assert.match(chatStyles, /\.agent-chat__input\s*\{[^}]*border-radius:\s*calc\(20px \* var\(--openclaw-corner-radius-scale\)\)/s);
  assert.match(source, /class="agent-chat__composer-shell new-session-page__composer"/);
  assert.match(source, /class="agent-chat__input agent-chat__input--mobile-toolbar"/);
  assert.match(workspaceStyles, /\.new-session-page__composer\.agent-chat__composer-shell\s*\{[^}]*margin-top: 0;/s);
  assert.doesNotMatch(workspaceStyles, /\.new-session-page \.launch__submit/);
  assert.doesNotMatch(chatStyles, /--chat-composer-(?:surface|hairline):[^;]*var\(--primary\)/);
});

test("the composer send control uses OpenClaw's SVG geometry and state colors", () => {
  const source = readFileSync(new URL("./home.ts", import.meta.url), "utf8");
  const styles = readStyles("../styles/openclaw-chat.css");

  assert.match(source, /const arrowUpIcon = icons\.arrowUp/);
  assert.match(source, /chat-send-btn chat-send-btn--send launch__submit/);
  assert.doesNotMatch(source, /\? "…" : "↑"/);
  assert.match(styles, /--chat-composer-send-size:\s*32px/);
  assert.match(styles, /\.agent-chat__input \.chat-send-btn--send > svg\s*\{[^}]*width:\s*21px;[^}]*height:\s*21px;/s);
  assert.match(styles, /\.agent-chat__input \.chat-send-btn:disabled\s*\{[^}]*background:\s*var\(--chat-composer-hover\);[^}]*color:\s*var\(--chat-composer-tertiary\);[^}]*opacity:\s*1;/s);
  assert.match(styles, /\.agent-chat__input \.chat-send-btn\s*\{[^}]*height:\s*var\(--chat-composer-send-size\);[^}]*color:\s*var\(--primary-foreground\);[^}]*box-shadow:\s*none;/s);
});

test("Task progress projects the durable progress_card signal above the composer", () => {
  const source = readFileSync(new URL("./home.ts", import.meta.url), "utf8");
  const styles = readStyles("../styles/openclaw-chat.css");

  assert.match(source, /progressCardFromTranscript\(props\.transcript\)/);
  assert.match(source, /class="session-progress-card session-progress-card--composer"/);
  assert.match(source, /item\.name !== "progress_card"/);
  assert.match(styles, /\.agent-chat__progress-float\s*\{[^}]*--chat-progress-underlap:\s*18px;/s);
  assert.ok(source.indexOf("${renderTaskProgress(props)}") > source.indexOf('<div class="agent-chat__composer-shell'));
  assert.match(source, /class="agent-chat__question-dock"/);
  assert.match(source, /agent-chat__composer-shell--question-composer/);
});

test("model and thinking reuse one exclusive composer picker pattern", () => {
  const source = readFileSync(new URL("./home.ts", import.meta.url), "utf8");
  const styles = readStyles("../styles/openclaw-chat.css");

  assert.match(source, /function prepareComposerPicker/);
  assert.match(source, /querySelectorAll<HTMLDetailsElement>\("details\[open\]"\)/);
  assert.match(source, /@click=\$\{prepareComposerPicker\}/);
  assert.match(source, /@keydown=\$\{closeComposerPicker\}/);
  assert.match(source, /class="chat-controls__reasoning-range"/);
  assert.match(source, /class="chat-controls__reasoning-dots"/);
  assert.match(source, /@input=\$\{/);
  assert.match(styles, /\.chat-controls__effort-menu\s*\{[^}]*width: min\(330px,/s);
  assert.match(styles, /\.chat-controls__reasoning-range::-webkit-slider-thumb\s*\{[^}]*width: 28px;[^}]*height: 20px;/s);
  assert.doesNotMatch(styles, /\.chat-controls__effort-picker\s*\{\s*display:\s*none;\s*\}/);
  assert.match(styles, /--chat-composer-chip-height:/);
  assert.match(source, /@toggle=\$\{positionComposerPicker\}/);
});

test("the model control remains visible while PI has no model catalog", () => {
  const source = readFileSync(new URL("./home.ts", import.meta.url), "utf8");
  const styles = readStyles("../styles/openclaw-chat.css");

  assert.match(source, /const label = current\?\.name \?\? "PI default"/);
  assert.match(source, /aria-disabled="true"/);
  assert.match(source, /No model catalog available/);
  assert.doesNotMatch(source, /Default \(Full Access\)/);
  assert.match(styles, /\.chat-controls__inline-select-trigger--disabled/);
});

test("the launch directory picker uses the themed combobox instead of a native datalist", () => {
  const source = readFileSync(new URL("./directory-picker.ts", import.meta.url), "utf8");
  const consumer = readFileSync(new URL("./home.ts", import.meta.url), "utf8");
  assert.match(consumer, /renderDirectoryPicker\(/);
  assert.doesNotMatch(consumer, /<datalist id="(?:launch-directories|group-default-directories)"/);
  const styles = readStyles("../styles/openclaw-workspaces.css") + readStyles("../styles/openclaw-launch.css");

  assert.match(source, /role="combobox"/);
  assert.match(source, /class="new-session-page__directory-menu" role="listbox"/);
  assert.match(source, /role="option"/);
  assert.doesNotMatch(source, /<datalist id="launch-directories"/);
  assert.match(styles, /\.new-session-page__directory-menu/);
});

test("the composer exposes PI context usage beside the model", () => {
  const source = readFileSync(new URL("./home.ts", import.meta.url), "utf8");
  const styles = readStyles("../styles/openclaw-chat.css");

  // Compact now waits while the session runs or a compaction already works,
  // and is not offered at all in a bot's permanent chat (the gateway refuses it).
  assert.match(source, /renderContextPicker\(props\.usage, props\.streaming \|\| props\.compaction\?\.status === "running" \? undefined : props\.onCompact, !props\.session\?\.bot\)/);
  assert.match(source, /\$\{compactable \? html`<button type="button" class="btn btn--ghost btn--sm context-usage__compact"/);
  assert.match(source, />Compact now<\/button>/);
  assert.match(source, /Context window/);
  assert.match(source, /Latest run tokens/);
  assert.match(styles, /\.context-ring__dial/);
  assert.match(source, /stroke-dashoffset/);
});

test("PI questions use the inline OpenClaw card instead of a modal", () => {
  const source = readFileSync(new URL("./home.ts", import.meta.url), "utf8");
  const styles = readStyles("../styles/openclaw-chat.css");

  assert.match(source, /class="session-question-card chat-question-panel"/);
  assert.match(source, /Type your own answer here/);
  assert.match(source, /secret \? "Cancel" : "Skip"/);
  assert.match(source, />Submit</);
  // A secret request is masked, kept from password managers and never prefilled.
  assert.match(source, /<input class="input" type="password" name="answer" autocomplete="one-time-code" aria-describedby=\$\{reasonId\} \/>/);
  assert.doesNotMatch(source, /class="question-dialog"/);
  assert.match(styles, /\.chat-question-panel\s*\{[^}]*gap: 12px;[^}]*padding: 14px;/s);
  assert.match(styles, /\.chat-question-panel__option\s*\{[^}]*padding: 10px 11px;/s);
});

test("New Session uses the dedicated PI mascot", () => {
  const source = readFileSync(new URL("./home.ts", import.meta.url), "utf8");

  assert.match(source, /src="\/pi-logo-3d\.png"/);
  assert.doesNotMatch(source, /src="\/apple-touch-icon\.png"/);
});

test("New Session exposes real model and effort controls without a permission fiction", () => {
  const source = readFileSync(new URL("./home.ts", import.meta.url), "utf8");

  assert.match(source, /launchModels: readonly RuntimeModel\[\]/);
  assert.match(source, /onSelectLaunchModel/);
  assert.match(source, /onSelectLaunchThinking/);
  assert.match(source, /class="agent-chat__composer-controls new-session-page__launch-controls chat-controls__model-settings"/);
  assert.match(source, /model: modelValue\(props\.launchModel\)/);
  assert.match(source, /thinking: props\.launchThinking/);
  assert.doesNotMatch(source, /Default \(Full Access\)/);
  assert.doesNotMatch(source, /new-session-page__permission/);
  assert.doesNotMatch(source, /<select[^>]*new-session-page__runtime/);
});

test("run details stay collapsed until the user asks to inspect them", () => {
  const source = readFileSync(new URL("./home.ts", import.meta.url), "utf8");
  const styles = readStyles("../styles/openclaw-chat.css");

  assert.match(source, /const expansionId = `\$\{props\.session\?\.id/);
  assert.match(source, /\.open=\$\{props\.expandedActivityIds\.has\(expansionId\)\}/);
  assert.match(source, /props\.onActivityExpanded\(expansionId, details\.open\)/);
  assert.doesNotMatch(source, /\?open=\$\{props\.streaming/);
  assert.match(styles, /\.chat-activity-group:not\(\[open\]\) \.chat-activity-group__body\s*\{\s*display: none;/);
});

test("thinking renders as plain intermediate text without a reasoning label", () => {
  const source = readFileSync(new URL("./home.ts", import.meta.url), "utf8");

  assert.match(source, /item\.kind === "thinking"[\s\S]*?class="chat-activity-message"/);
  assert.doesNotMatch(source, /_Reasoning:_/);
  assert.doesNotMatch(source, /class="chat-thinking"/);
  assert.doesNotMatch(source, /class="chat-thinking"/);
});

test("the primary runtime working state is contextual and child activity remains explicit", () => {
  const source = readFileSync(new URL("./home.ts", import.meta.url), "utf8");

  assert.match(source, /renderWorkingIndicator\(props\)/);
  assert.match(source, /class="chat-working-indicator__label"/);
  assert.match(source, /role="status"/);
  assert.doesNotMatch(source, /hui-run-elapsed/);
  assert.match(source, /class="chat-subagents__row/);
  assert.doesNotMatch(source, /subagentClawIcon/);
  assert.match(source, /props\.onSelectSubagent\(task\.sessionId\)/);
});

test("text inputs do not inherit the global focus halo", () => {
  const appStyles = readFileSync(new URL("../styles/app.css", import.meta.url), "utf8");
  const workspaceStyles = readStyles("../styles/openclaw-workspaces.css") + readStyles("../styles/openclaw-launch.css");

  assert.doesNotMatch(appStyles, /:where\(input, textarea, select\):focus-visible\s*\{[^}]*box-shadow:\s*var\(--focus-ring\)/s);
  assert.match(readStyles("../styles/openclaw-chat.css"), /\.agent-chat__composer-combobox > :is\(textarea, input\):focus-visible\s*\{\s*box-shadow: none;/);
  assert.match(readStyles("../styles/openclaw-reference/components.css"), /\.data-table-search input:focus-visible\s*\{\s*border-color: var\(--border-strong\);\s*box-shadow: var\(--focus-ring\);/);
  assert.doesNotMatch(workspaceStyles, /\.sessions-toolbar__search input:focus\s*\{/);
  assert.doesNotMatch(workspaceStyles, /\.settings-shell \.settings-sidebar__search-input:focus\s*\{[^}]*var\(--focus-ring\)/s);
});

test("recent chats on New Session reopen an existing session", () => {
  const source = readFileSync(new URL("./home.ts", import.meta.url), "utf8");

  assert.match(source, /class="agent-chat__recent new-session-page__recent-row"/);
  assert.match(source, /props\.onSelectSession\(session\)/);
  assert.match(readStyles("../styles/openclaw-chat.css"), /\.agent-chat__recent\s*\{[^}]*padding: 8px 12px;/s);
});

test("recent chats list top-level sessions only, never subagents", async () => {
  const at = "2026-10-20T00:00:00Z";
  const row = (id: string, parentId?: string) => ({ id, title: id, group: "", cwd: "/repo", tool: "durable", status: "idle", createdAt: at, updatedAt: at, ...(parentId ? { parentId } : {}) });
  const html = await renderWorkerSession("idle", { session: undefined, workers: [], directorySuggestions: [], launchModels: [], groups: [{ label: "", sessions: [row("Parent"), row("Helper", "Parent"), row("Grandchild", "Helper")] }] });
  assert.match(html, /aria-label=Open Parent/u);
  assert.doesNotMatch(html, /Open (Helper|Grandchild)/u);
});

test("session actions live in the sidebar instead of the chat header", () => {
  const homeSource = readFileSync(new URL("./home.ts", import.meta.url), "utf8");
  const shellSource = readFileSync(new URL("./shell.ts", import.meta.url), "utf8");

  assert.doesNotMatch(homeSource, /chat-pane__desktop-actions/);
  assert.doesNotMatch(homeSource, /chat-pane__mobile-actions/);
  assert.doesNotMatch(homeSource, /aria-label="Session actions"/);
  assert.match(shellSource, /<wa-dropdown-item value="rename"[\s\S]*?Rename/);
  assert.match(shellSource, /<wa-dropdown-item value="delete"[\s\S]*?Delete/);
  // New sessions start from each group's +; the sidebar header has no New session button.
  assert.match(shellSource, /aria-label=\$\{`New session in /);
});

test("the chat header exposes original same-session split controls and pane-local close", () => {
  const source = readFileSync(new URL("./home.ts", import.meta.url), "utf8");

  assert.match(source, /aria-label="Open split view"/);
  assert.match(source, /aria-label="Split right"/);
  assert.match(source, /aria-label="Split down"/);
  assert.match(source, /aria-label="Pane actions"/);
  assert.doesNotMatch(source, /splitCandidates/);
  assert.doesNotMatch(source, /onSplitSession\?: \(session: SessionView\) => void/);
  assert.match(source, /aria-label="Close session pane"/);
  assert.match(source, /@click=\$\{props\.onClosePane\}/);
});

test("session rename mirrors the Control UI single title field without a group editor", () => {
  const source = readFileSync(new URL("./home.ts", import.meta.url), "utf8");
  const editor = source.slice(source.indexOf("function renderSessionEditor"), source.indexOf("function renderDeleteConfirmation"));
  assert.match(editor, /class="chat-pane__session-title-input"/);
  assert.match(editor, /event\.key === "Enter"/);
  assert.match(editor, /event\.key === "Escape"/);
  assert.match(editor, /@blur=/);
  assert.doesNotMatch(editor, /name="group"|<button|<form/);
  assert.match(source, /onRename: \(title: string\) => void;/);
});

test("composer notices render above the progress card and queue, which underlap their next sibling", () => {
  const source = readFileSync(new URL("./home.ts", import.meta.url), "utf8");
  const order = ["${renderRunError(", "agent-chat__interrupted-recovery\" role", "${renderTaskProgress(", "${renderQueue(", "<form class=\"agent-chat__input"]
    .map((marker) => source.indexOf(marker));
  assert.ok(order.every((index, i) => index > 0 && (i === 0 || index > order[i - 1]!)), String(order));
});

/** A Lit template's markup, with bound values written out. */
function markup(value: unknown): string {
  if (Array.isArray(value)) return value.map(markup).join("");
  if (value && typeof value === "object" && "strings" in value && "values" in value) {
    const template = value as { strings: readonly string[]; values: unknown[] };
    return template.strings.map((part, i) => part + markup(template.values[i])).join("");
  }
  // A directive's arguments, such as the HTML `unsafeHTML` renders.
  if (value && typeof value === "object" && "_$litDirective$" in value && "values" in value) return markup((value as { values: unknown[] }).values);
  return ["string", "number", "boolean"].includes(typeof value) ? String(value) : "";
}

/** An open worker session; handlers are inert and unlisted props absent. */
async function renderWorkerSession(status: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const { renderHome } = await import("./home.ts");
  const props: Record<string, unknown> = {
    session: { id: "s", title: "Build", group: "", cwd: "/repo", displayCwd: "devbox:/repo", tool: "durable", status, worker: { id: "w", name: "devbox" } },
    transcript: [{ kind: "message", role: "user", text: "long task" }], subagents: [], draft: "keep this draft", attachments: [],
    connection: "live", connectionNote: "", queue: { steering: [], followUp: [] }, models: [], expandedActivityIds: new Set(),
    chatPreferences: { collapseTaskProgress: false, sendShortcut: "enter", githubEmbeds: false, datadogEmbeds: false },
    commandMenu: { open: false, commands: [], activeIndex: 0, paths: [] }, localPathMenu: { open: false, paths: [], activeIndex: 0 },
    findSession: (id: string) => ((overrides["groups"] ?? []) as { sessions: { id: string }[] }[]).flatMap((group) => group.sessions).find((session) => session.id === id),
    ...overrides,
  };
  const inert = new Proxy(props, { get: (target, key) => key in target ? target[key as string] : typeof key === "string" && key.startsWith("on") ? () => {} : undefined });
  return markup(renderHome(inert as unknown as import("./home.ts").HomeProps)).replace(/\s+/gu, " ");
}

test("Effort offers the model's own levels up to Maximum, and Speed only where fast mode applies", async () => {
  const opus = { provider: "gw", id: "anthropic/claude-opus-5-5", name: "Opus", thinkingLevels: ["low", "medium", "high", "xhigh", "max"], fast: true };
  const html = await renderWorkerSession("idle", { currentModel: opus, thinking: "max", fast: true });
  assert.equal(html.split('class="chat-controls__reasoning-dot"').length - 1, 5);
  assert.match(html, /max=4 step="1" \.value=4/u);
  assert.match(html, /aria-label=Thinking: max, fast/u);
  assert.match(html, /<span class="chat-controls__inline-select-label">Maximum<\/span>/u);
  assert.match(html, /aria-checked=false[^>]*>Standard<\/button>.*aria-checked=true[^>]*>Fast<\/button>/u);

  // A level the model lacks shows what PI sends instead; no Speed while the runtime cannot change it.
  const older = { ...opus, thinkingLevels: ["off", "minimal", "low", "medium", "high"] };
  const clamped = await renderWorkerSession("idle", { currentModel: older, thinking: "max" });
  assert.match(clamped, /<span class="chat-controls__inline-select-label">High<\/span>/u);
  assert.doesNotMatch(clamped, /chat-controls__speed-panel/u);
  assert.doesNotMatch(await renderWorkerSession("idle", { currentModel: { ...opus, fast: undefined }, thinking: "high", fast: false }), /chat-controls__speed-panel/u);
});

test("Ultra is the stop above Maximum where the runtime offers it, and both glow", async () => {
  const opus = { provider: "gw", id: "anthropic/claude-opus-5-5", name: "Opus", thinkingLevels: ["low", "medium", "high", "xhigh", "max", "ultra"] };
  const ultra = await renderWorkerSession("idle", { currentModel: opus, thinking: "ultra" });
  assert.match(ultra, /max=5 step="1" \.value=5 [^>]*data-effort-boost=ultra/u);
  assert.match(ultra, /<span class="chat-controls__inline-select-label">Ultra<\/span>/u);
  assert.match(await renderWorkerSession("idle", { currentModel: opus, thinking: "max" }), /data-effort-boost=max/u);
  // A runtime without Ultra sends the model's highest level for it.
  const pi = await renderWorkerSession("idle", { currentModel: { ...opus, thinkingLevels: opus.thinkingLevels.slice(0, -1) }, thinking: "ultra" });
  assert.match(pi, /<span class="chat-controls__inline-select-label">Maximum<\/span>/u);
});

const sendButton = (html: string) => html.match(/<button type="submit" class="chat-send-btn chat-send-btn--send" \?disabled=(\w+)/u)?.[1];

test("a worker session HUI is reconnecting to reads calm: a status, one notice, the draft kept and no failure", async () => {
  const html = await renderWorkerSession("reconnecting");
  assert.match(html, /durable on devbox · [^<]* · Reconnecting to devbox… </u);
  assert.match(html, /Reconnecting to devbox — draft preserved\./u);
  assert.equal(html.split("Connection to devbox lost — the session keeps running there. HUI reconnects automatically.").length, 2, "exactly one notice");
  assert.doesNotMatch(html, /The runtime could not start|Retry session|chat-error|exited|no longer streaming|Stream stopped/u);
  assert.doesNotMatch(html, /reconnect-session/u, "HUI reconnects by itself; there is nothing to click");
  assert.match(html, /\.value=keep this draft/u);
  assert.match(html, /placeholder=Draft while HUI reconnects…/u);
  assert.equal(sendButton(html), "true", "sending waits for the worker");
});

test("a worker session HUI no longer retries says it is disconnected and offers Reconnect", async () => {
  const html = await renderWorkerSession("disconnected");
  assert.match(html, /· Disconnected from devbox </u);
  assert.match(html, /Disconnected from devbox — draft preserved\./u);
  assert.match(html, /Disconnected from devbox\. The session may still be running there\. <button type="button" class="btn btn--sm reconnect-session" @click=>Reconnect<\/button>/u);
  assert.doesNotMatch(html, /The runtime could not start|Retry session|chat-error|exited|no longer streaming|Stream stopped/u);
  assert.match(html, /\.value=keep this draft/u);
  assert.equal(sendButton(html), "true");
});

test("a reachable worker session shows neither notice, and a failed one keeps its error banner", async () => {
  const idle = await renderWorkerSession("idle");
  assert.doesNotMatch(idle, /Reconnecting to|Disconnected from|reconnect-session/u);
  assert.equal(sendButton(idle), "false");
  assert.match(await renderWorkerSession("error"), /The runtime could not start\./u);
});

test("a conversation still downloading shows progress, and one that failed to load offers a retry instead of an empty chat", async () => {
  const loading = await renderWorkerSession("idle", { transcript: [], opening: true });
  assert.match(loading, /role="status" aria-live="polite"> <span>Loading the conversation…<\/span> <wa-progress-bar label="Loading the conversation" indeterminate>/u);
  assert.doesNotMatch(loading, /Start a conversation/u);

  const failed = await renderWorkerSession("idle", { transcript: [], openError: "HUI did not answer within 20 s. Check the connection and try again." });
  assert.match(failed, /<div class="agent-chat__empty" role="alert"> <strong>Could not load this conversation<\/strong> <span>HUI did not answer within 20 s\. Check the connection and try again\.<\/span> <button type="button" class="btn btn--sm retry-session" @click=>Try again<\/button>/u);
  assert.doesNotMatch(failed, /Start a conversation|Send a message below/u, "a failed load never reads as an empty session");
});

test("the Parallel tasks card counts the latest batch of subagents and folds a batch that all succeeded", async () => {
  const startedAt = new Date(Date.now() - 60_000).toISOString();
  const endedAt = new Date(Date.now() - 10_000).toISOString();
  const task = (taskId: string, status: string, extra: Record<string, unknown> = {}) =>
    ({ taskId, sessionId: `s-${taskId}`, parentSessionId: "s", title: `Check ${taskId}`, task: "t", status, startedAt, updatedAt: endedAt, ...extra });
  const card = (html: string) => html.slice(html.indexOf('<aside class="chat-swarm"'), html.indexOf("</aside>"));

  const active = card(await renderWorkerSession("idle", { subagents: [
    task("a", "running"), task("b", "starting"), task("c", "queued"), task("d", "failed", { endedAt, error: "Provider refused" }),
  ] }));
  assert.match(active, /<strong title=Parallel tasks>Parallel tasks<\/strong><span>1 of 4<\/span>/u);
  assert.match(active, /<span class="chat-swarm__counts">2 running · 1 queued · 1 failed or stopped<\/span>/u);
  assert.equal(active.match(/chat-swarm__marker chat-swarm__marker--/gu)?.length, 4);
  assert.match(active, /Waiting for a free slot…/u);
  assert.match(active, /Provider refused/u);
  assert.doesNotMatch(active, /Child runs finished/u);

  const finished = card(await renderWorkerSession("idle", { streaming: true, subagents: [
    task("a", "completed", { endedAt }), task("b", "cancelled", { endedAt }),
  ] }));
  assert.match(finished, /1 completed · 1 failed or stopped/u);
  assert.match(finished, /Child runs finished\. The parent is processing their results\./u);

  const succeeded = card(await renderWorkerSession("idle", { subagents: [task("a", "completed", { endedAt }), task("b", "completed", { endedAt })] }));
  assert.match(succeeded, /chat-swarm__group--completed/u);
  assert.match(succeeded, /<span class="chat-swarm__counts">2 completed<\/span>/u);
  assert.doesNotMatch(succeeded, /chat-swarm__marker /u);
  assert.match(succeeded, /Child runs finished\. Check the conversation for the final response\./u);
});

test("messages HUI delivered from bots, sessions and routines show their sender on the left, never as yours", async () => {
  const grace = { id: "b-grace", handle: "grace", name: "Grace", avatar: { color: "#2fc49a" } };
  const fix = { id: "s-fix", title: "Implement retry fix", group: "", cwd: "/repo", tool: "durable", status: "idle" };
  const helper = { ...fix, id: "s-helper", title: "Context lane", parentId: "grace-chat" };
  const sessions = [fix, helper];
  const findSession = (id: string) => sessions.find((session) => session.id === id);
  const html = await renderWorkerSession("idle", { bots: [grace], groups: [{ name: "", sessions: [fix] }], findSession, transcript: [
    { kind: "message", id: "u", role: "user", text: "@grace babysit PR #7" },
    { kind: "tool", id: "m", name: "message_bot", status: "succeeded", args: { to: "@grace", message: "Babysit PR #7. Keep 3 retries." }, output: "Queued for @grace." },
    { kind: "message", id: "a", role: "assistant", text: "Handed to Grace." },
    { kind: "message", id: "g", role: "user", text: "[from @grace · hop 2] PR #7 review needs your decision." },
    { kind: "message", id: "x", role: "user", text: "[from @ghost] Still here." },
    { kind: "message", id: "s", role: "user", text: "[from agent: Implement retry fix · reply-to agent:s-fix] Please babysit PR #7." },
    { kind: "message", id: "h", role: "user", text: "[Inter-session message from Context lane (s-helper)]\nAlert history attached." },
    { kind: "message", id: "r", role: "user", text: "[routine: Daily standup] Summarize yesterday." },
  ] });
  const row = (id: string) => html.slice(html.indexOf(`data-chat-row-key=${id}`), html.indexOf("data-chat-row-key=", html.indexOf(`data-chat-row-key=${id}`) + 1));

  const bot = row("g");
  assert.match(html, /class="chat-group user [^"]*chat-group--peer[^"]*" data-chat-row-key=g style=--chat-sender-color: #2fc49a>/u);
  assert.match(bot, /<span class="chat-sender-avatar" aria-hidden="true"><span class="bot-avatar bot-avatar--sm bot-avatar--face"/u);
  assert.match(bot, /<div class="chat-text">.*PR #7 review needs your decision\./u);
  assert.match(bot, /<a class="chat-sender-name chat-sender-link" href=\/bots\/b-grace @click=>Grace<\/a>/u);
  assert.match(bot, /aria-label=Copy message/u);
  assert.doesNotMatch(bot, /\[from @grace|>You<|chat-group-rewind/u);

  assert.match(row("x"), /<span class="chat-sender-icon">G<\/span>.*<span class="chat-sender-name">@ghost<\/span>/u, "a bot HUI doesn't know: its handle, no guessed face");
  assert.match(row("s"), /<span class="chat-sender-icon"><svg.*<a class="chat-sender-name chat-sender-link" href=\/sessions\/s-fix @click=>Implement retry fix<\/a>/u);
  assert.match(row("h"), /<a class="chat-sender-name chat-sender-link" href=\/sessions\/s-helper @click=>Context lane<\/a>/u, "a bot's subagent, which no session list shows, still links");
  const child = await renderWorkerSession("idle", {
    session: { ...helper, status: "idle" },
    findSession: (id: string) => id === "grace-chat" ? { ...fix, id: "grace-chat", title: "Grace", bot: { id: "b-grace", handle: "grace", name: "Grace" } } : undefined,
    transcript: [{ kind: "message", id: "t", role: "user", text: "[Subagent Task]\nCheck the alert history." }],
  });
  assert.match(child, /<a class="chat-sender-name chat-sender-link" href=\/bots\/b-grace @click=>Grace<\/a>/u, "a bot subagent's parent is its bot's chat in the Bots tab");
  assert.match(row("r"), /<div class="chat-text chat-text--plain">Summarize yesterday\.<\/div>.*<span class="chat-sender-name">Daily standup<\/span><span class="chat-message-source" title=Routine>Routine<\/span>/u);
  assert.match(row("u"), /<span class="chat-sender-name">You<\/span>/u);

  const handoff = row("m");
  assert.match(handoff, /<details class="chat-tool-msg-collapse chat-handoff" data-status=succeeded style=--chat-sender-color: #2fc49a/u);
  assert.match(handoff, /<span class="chat-tool-msg-summary__label">Sent to <strong>Grace<\/strong><\/span> <span class="chat-tool-msg-summary__preview">Babysit PR #7\. Keep 3 retries\.<\/span>/u);
  assert.doesNotMatch(handoff, /Ran 1 command/u);
});

test("link previews and cards render on the latest user message and the latest reply only", async () => {
  const slack = "https://acme.slack.com/archives/C01234567/p1723456789012345";
  const html = await renderWorkerSession("idle", {
    chatPreferences: { collapseTaskProgress: false, sendShortcut: "enter", githubEmbeds: true, datadogEmbeds: true },
    transcript: [
      { kind: "message", id: "u1", role: "user", text: slack },
      { kind: "message", id: "a1", role: "assistant", text: "https://x.com/openai/status/123456789" },
      { kind: "message", id: "u2", role: "user", text: "Review https://github.com/acme/web/pull/12" },
      { kind: "message", id: "u3", role: "user", text: "and https://github.com/acme/web/pull/14" },
      { kind: "message", id: "a2", role: "assistant", text: `Opened https://github.com/acme/web/pull/13\n\n${slack}` },
      { kind: "message", id: "u4", role: "user", text: slack, failed: true },
      { kind: "message", id: "u5", role: "user", text: slack, pending: true },
    ],
  });
  const message = (id: string) => html.slice(html.indexOf(`data-message-id=${id}`), html.indexOf("data-message-id=", html.indexOf(`data-message-id=${id}`) + 1));
  const previews = /<hui-github-embeds .*<hui-datadog-embeds /u;
  const cards = /<hui-(?:github-embeds|datadog-embeds|slack-link|tweet-embed)/u;

  assert.ok(message("u1").includes(`<div class="chat-text chat-text--plain">${slack}</div>`), "an older Slack link stays text");
  assert.match(message("a1"), /<p><a href="https:\/\/x\.com\/openai\/status\/123456789"/u, "an older X post stays a link");
  for (const old of ["u1", "a1", "u2"]) assert.doesNotMatch(message(old), cards);
  assert.match(message("u3"), previews, "the last message of its group, and the latest one sent");
  assert.match(message("a2"), previews);
  assert.match(message("a2"), /<hui-slack-link data-url="https:\/\/acme\.slack\.com/u);
  for (const unsent of ["u4", "u5"]) assert.doesNotMatch(message(unsent), cards, "a message not sent (yet) leaves the cards to the one before it");
});

test("what an agent sends shows its target: a bot by handle or name, the calling agent's session, or why it wasn't sent", async () => {
  const grace = { id: "b-grace", handle: "grace", name: "Grace", avatar: { color: "#2fc49a" } };
  const groups = [{ name: "", sessions: [{ id: "s-fix", title: "Implement retry fix", group: "", cwd: "/repo", tool: "durable", status: "idle" }] }];
  const call = (id: string, to: string | undefined, status: string, output?: string) =>
    ({ kind: "tool", id, name: "message_bot", status, args: to === undefined ? {} : { to, message: "Keep the limit?" }, ...(output ? { output } : {}) });
  const html = await renderWorkerSession("idle", { bots: [grace], groups, transcript: [
    { kind: "message", id: "u", role: "user", text: "go" },
    call("by-name", "Grace", "succeeded"),
    call("agent", "agent:s-fix", "succeeded"),
    call("gone", "agent:s-gone", "succeeded"),
    call("refused", "@ghost", "failed", "No bot is called \"@ghost\"."),
    call("pending", undefined, "running"),
  ] });
  const label = (id: string) => html.slice(html.indexOf(`data-chat-row-key=${id}`)).match(/<span class="chat-tool-msg-summary__label">(.*?)<\/span>/u)?.[1];
  assert.equal(label("by-name"), "Sent to <strong>Grace</strong>");
  assert.equal(label("agent"), "Sent to <strong>Implement retry fix</strong>");
  assert.equal(label("gone"), "Sent to <strong>the calling agent</strong>");
  assert.equal(label("refused"), "Not sent to <strong>@ghost</strong>");
  assert.match(html, /data-status=failed[^]*<p class="chat-run-error" role="alert">No bot is called "@ghost"\.<\/p>/u);
  // No target yet (its arguments still on their way): an ordinary tool row, never "Sending to @".
  const pending = html.slice(html.indexOf("data-chat-row-key=pending"));
  assert.doesNotMatch(pending, /chat-handoff/u);
  assert.match(pending, /chat-activity-group/u);
});

test("an unanswered questionnaire reads as expired with what it asked, never as declined", async () => {
  const asked = { questions: [{ header: "Auth", question: "Which auth method?", options: [{ label: "OAuth (Recommended)", description: "" }, { label: "API key", description: "" }] }] };
  const call = (id: string, details: Record<string, unknown>, args: unknown = asked) => ({ kind: "tool", id, name: "ask_user_question", status: "succeeded", args, details });
  const timedOut = { cancelled: true, answers: [], timedOut: true, timeoutMinutes: 10 };
  const html = await renderWorkerSession("idle", { transcript: [
    { kind: "message", id: "u", role: "user", text: "go" },
    call("expired", timedOut),
    // A lone question outside a list, which PI's argument conversion wraps before the gateway checks the call.
    call("lone", timedOut, { questions: asked.questions[0] }),
    call("declined", { cancelled: true, answers: [] }),
  ] });
  const row = (id: string) => html.slice(html.indexOf(`data-chat-row-key=${id}`), html.indexOf("data-chat-row-key=", html.indexOf(`data-chat-row-key=${id}`) + 1));
  const expired = row("expired");
  assert.match(expired, /<div class=chat-question-summary chat-question-summary--expired role="note" aria-label=Unanswered questions>/u);
  assert.match(expired, /<strong>Expired<\/strong><span>No answer within 10 minutes\. The agent continued without your answer; reply in the chat to decide\.<\/span>/u);
  assert.match(expired, /<strong>Auth<\/strong><span>Which auth method\? <span class="chat-question-summary__options">OAuth \(Recommended\), API key<\/span><\/span>/u);
  assert.doesNotMatch(expired, /declined|<form|<button/u);
  assert.match(row("lone"), /<strong>Auth<\/strong><span>Which auth method\? <span class="chat-question-summary__options">OAuth \(Recommended\), API key<\/span>/u);
  assert.match(row("declined"), /You declined to answer\./u);
});

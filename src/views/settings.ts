/**
 * The Settings shell: its page list, drawer and search, and the render functions for the built-in pages. Edits leave
 * through prop callbacks to the app; the pi-backed pages only report pi's configuration, and self-contained sections
 * (providers, integrations, tools, browser, workers, calls) are their own elements.
 */
import { html, nothing, type TemplateResult } from "lit";
import { TERMINAL_FONTS, normalizeTerminalFont, terminalFontStack } from "../lib/terminal/font.ts";
import { TEXT_SCALE_STOPS, TYPEFACES, type TextScaleStop } from "../lib/theme/appearance.ts";
import { modeIsSelectable, THEME_MODES, type ThemeMode, type ThemeVariant } from "../lib/theme/theme.ts";
import { QUESTION_TIMEOUTS, type Settings } from "../lib/settings/settings.ts";
import type { PowerState, PowerStatus } from "../api/schema/power.ts";
import type { ThemePreview } from "../lib/theme/theme-store.ts";
import type { ThemeSwatches } from "../lib/theme/shadcn-theme.ts";
import { skillIsEnabled, type PiMutationState, type PiSnapshot } from "../lib/pi.ts";
import type { GatewayHealth, WorkspaceInspection } from "../api/control-surfaces.ts";
import { formatGatewayUptime } from "../lib/gateway-presentation.ts";
import type { ObservabilitySnapshot } from "../api/observability.ts";
import { icons } from "../lib/icons.ts";
import { hasOpenWebAwesomePopup } from "../lib/web-awesome.ts";
import { renderPicker, renderSettingsPicker } from "./settings-picker.ts";
import { renderListFilter } from "../components/list-filter.ts";
import { renderSettingsToggle } from "./settings-toggle.ts";
import "../components/settings/tools.ts";
import "../components/settings/browser.ts";
import "../components/settings/vscode.ts";
import "../components/settings/jira.ts";
import "../components/settings/calls.ts";
import "../components/settings/github.ts";
import "../components/settings/datadog.ts";
import "../components/settings/providers.ts";
import "../components/settings/workers.ts";
import { renderAutomationPage, type AutomationProps } from "./settings-automation.ts";
import { renderWorktreesPage, type WorktreesPageProps } from "./worktrees.ts";
import {
  bindDrawerToNarrowMedia,
  type DrawerMediaQuery,
  APP_SHELL_DRAWER_MEDIA,
  unbindDrawerMedia,
} from "./shell.ts";
import { loadViewAssets } from "../lib/view-assets.ts";

loadViewAssets(() => import("../styles/openclaw-workspaces.css"));

const MODE_LABELS: Record<ThemeMode, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

const SCALE_LABELS: Record<TextScaleStop, string> = {
  90: "Small",
  100: "Default",
  110: "Large",
  125: "XL",
  140: "XXL",
};

export const SETTINGS_PAGES = [
  { id: "appearance", label: "Appearance", group: "", icon: "palette" },
  { id: "connection", label: "Gateway", group: "Connections", icon: "radio" },
  { id: "integrations", label: "Integrations", group: "Connections", icon: "grid" },
  { id: "workers", label: "Workers", group: "Connections", icon: "globe" },
  { id: "models", label: "Models", group: "Agents & Tools", icon: "box" },
  { id: "plugins", label: "Plugins", group: "Agents & Tools", icon: "plug" },
  { id: "skills", label: "Skills", group: "Agents & Tools", icon: "zap" },
  { id: "tools", label: "Tools", group: "Agents & Tools", icon: "wrench" },
  { id: "memory", label: "Memory", group: "Agents & Tools", icon: "book" },
  { id: "automation", label: "Automation", group: "Agents & Tools", icon: "terminal" },
  { id: "security", label: "Privacy & Security", group: "Privacy & Security", icon: "shieldCheck" },
  { id: "worktrees", label: "Worktrees", group: "System", icon: "gitBranch" },
  { id: "diagnostics", label: "Diagnostics", group: "System", icon: "bug" },
] as const;

export type SettingsPage = (typeof SETTINGS_PAGES)[number]["id"];

const SETTINGS_GROUPS = ["", "Connections", "Agents & Tools", "Privacy & Security", "System"] as const;
export const SETTINGS_DRAWER_DEFAULT_OPEN = false;


export function filterSettingsPages(query: string) {
  const normalized = query.trim().toLocaleLowerCase();
  return normalized
    ? SETTINGS_PAGES.filter((page) => `${page.label} ${page.group}`.toLocaleLowerCase().includes(normalized))
    : [...SETTINGS_PAGES];
}

export type SettingsProps = AutomationProps & {
  page: SettingsPage;
  worktrees: WorktreesPageProps;
  /** `undefined` while loading, so an empty list is never shown as "none". */
  pi: PiSnapshot | undefined;
  piLoading: boolean;
  piError: string;
  health: GatewayHealth | undefined;
  healthError: string;
  /** Unknown while loading or unreachable; `null` when the gateway is not on macOS. */
  power: PowerStatus | null | undefined;
  workspaces: WorkspaceInspection | undefined;
  workspaceError: string;
  observability: ObservabilitySnapshot | undefined;
  observabilityError: string;
  onRefreshObservability: () => void;
  onExportDiagnostics: () => void;
  onRetryPi: () => void;
  onSelectPage: (page: SettingsPage) => void;
  previews: readonly ThemePreview[];
  settings: Settings;
  themeId: string;
  variant: ThemeVariant;
  saveFailed: boolean;
  importNote: string;
  importFailed: boolean;
  onSelectTheme: (id: string) => void;
  onSelectMode: (mode: ThemeMode) => void;
  onSelectAccent: (accent: string) => void;
  onChangeBranchPrefix: (prefix: string) => void;
  onChangeAppearance: (next: Partial<Pick<Settings, "fontUi" | "fontChat" | "fontTerminal" | "textScale">>) => void;
  onChangeChat: (next: Settings["chat"]) => void;
  /** Resolves once the settings write lands, so the Browser section can re-read status. */
  onChangeBrowser: (next: Settings["browser"]) => Promise<unknown> | void;
  /** Resolves once the settings write lands, so the VS Code section can re-read status. */
  onChangeVscode: (next: Settings["vscode"]) => Promise<unknown> | void;
  onChangeCodemode: (next: Settings["codemode"]) => void;
  onChangeQuestions: (next: Settings["questions"]) => void;
  onChangeModels: (next: Settings["models"]) => void;
  onChangeCalls: (next: Settings["calls"]) => void;
  onChangePower: (next: Settings["power"]) => void;
  onSetLidAwake: (on: boolean) => void;
  onImportTheme: (url: string) => void;
  onClose: () => void;
  piOperation?: PiMutationState;
  piRemoveCandidate: string;
  onInstallPackage: (url: string) => void;
  onRequestRemovePackage: (source: string) => void;
  onCancelRemovePackage: () => void;
  onConfirmRemovePackage: (source: string) => void;
  onInstallSkill: (url: string) => void;
  onSetSkillEnabled: (skill: PiSnapshot["skills"][number], enabled: boolean) => void;
  onSetPluginEnabled: (resource: PiSnapshot["settings"]["resources"][number], enabled: boolean) => void;
  onReadSkill: (skill: PiSnapshot["skills"][number]) => void;
  onReadPlugin: (resource: PiSnapshot["settings"]["resources"][number]) => void;
};

/** Swatches come from the theme file, so the inline style is data-driven. */
function renderThemeCard(
  preview: ThemePreview,
  selected: boolean,
  onSelect: (id: string) => void,
) {
  const swatches: (keyof ThemeSwatches)[] = ["accent", "text", "raised", "background"];
  return html`
    <button
      type="button"
      class="settings-theme-card ${selected ? "settings-theme-card--active" : ""}"
      aria-pressed=${String(selected)}
      @click=${() => onSelect(preview.id)}
    >
      <span class="settings-theme-card__palette" aria-hidden="true">
        ${swatches.slice(0, 3).map(
          (name) => html`<span class="settings-theme-card__chip" style="background: ${preview[name]}"></span>`,
        )}
      </span>
      <span class="settings-theme-card__label">${preview.name}</span>
    </button>
  `;
}

/** Heading and description sit outside the card, so rows own their inset. */
function renderSection(heading: string, description: string, body: TemplateResult, section?: string) {
  return html`
    <section class="settings-section" data-settings-section=${section ?? nothing}>
      <div class="settings-section__header">
        <div class="settings-section__copy">
          <h2 class="settings-section__heading">${heading}</h2>
          ${description ? html`<p class="settings-section__desc">${description}</p>` : nothing}
        </div>
      </div>
      <div class="settings-group">${body}</div>
    </section>
  `;
}

function renderRow(title: string, description: string, control: TemplateResult) {
  return html`
    <div class="settings-row">
      <div class="settings-row__text">
        <span class="settings-row__title">${title}</span>
        <span class="settings-row__desc">${description}</span>
      </div>
      <div class="settings-row__control">${control}</div>
    </div>
  `;
}

function renderImportRow(props: SettingsProps) {
  return html`
    <div class="settings-row settings-row--stacked">
      <p class="settings-theme-import__inline-hint">Choose <strong>Import</strong> to load a theme from tweakcn.</p>
      <form class="settings-theme-import" id="theme-import" hidden @submit=${onImportSubmit(props)}>
        <div class="settings-theme-import__copy">
          <div class="settings-theme-import__title">Import from tweakcn</div>
          <p class="settings-theme-import__hint">Paste a theme link or id. Saved to <code>~/.config/hui/themes/</code>.</p>
        </div>
        <a class="settings-theme-import__external" href="https://tweakcn.com/editor/theme" target="_blank" rel="noopener noreferrer">Browse tweakcn ${icons.externalLink}</a>
        <label class="settings-theme-import__field">
          <span class="settings-theme-import__label">Theme link</span>
          <input class="settings-theme-import__input" type="text" name="url" placeholder="https://tweakcn.com/themes/..." aria-label="tweakcn theme link"
            @input=${(event: Event) => {
              const input = event.currentTarget as HTMLInputElement;
              const button = input.form?.querySelector<HTMLButtonElement>('button[type="submit"]');
              if (button) button.disabled = !input.value.trim();
            }} />
        </label>
        <div class="settings-theme-import__actions"><button type="submit" class="btn btn--sm primary" disabled>Import theme</button></div>
        ${renderImportNote(props)}
      </form>
    </div>
  `;
}

function onImportSubmit(props: SettingsProps) {
  return (event: SubmitEvent) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!(form instanceof HTMLFormElement)) {
      return;
    }
    const input = form.elements.namedItem("url");
    if (input instanceof HTMLInputElement && input.value.trim()) {
      props.onImportTheme(input.value);
      input.value = "";
      const button = form.querySelector<HTMLButtonElement>('button[type="submit"]');
      if (button) button.disabled = true;
    }
  };
}

function renderImportNote(props: SettingsProps) {
  if (!props.importNote) {
    return nothing;
  }
  return html`<p class="settings-theme-import__message settings-theme-import__message--${props.importFailed ? "error" : "success"}" role=${props.importFailed ? "alert" : "status"}>
    ${props.importNote}
  </p>`;
}

function renderThemeSection(props: SettingsProps) {
  const selectable = modeIsSelectable(props.variant);
  // With a single-mode theme the preference is moot, so show what is actually
  // in effect rather than highlighting a button that does not match the screen.
  const shownMode = selectable ? props.settings.themeMode : props.variant;
  const body = html`
    ${
      props.previews.length > 0
        ? html`<div class="settings-row settings-row--stacked">
            <div class="settings-theme-grid">
              ${props.previews.map((preview) =>
                renderThemeCard(preview, preview.id === props.themeId, props.onSelectTheme),
              )}
              <button type="button" class="settings-theme-card settings-theme-card--custom" aria-controls="theme-import" aria-expanded="false"
                @click=${(event: Event) => {
                  const button = event.currentTarget as HTMLButtonElement;
                  const group = button.closest(".settings-group");
                  const form = group?.querySelector<HTMLFormElement>(".settings-theme-import");
                  if (!form) return;
                  form.hidden = false;
                  const hint = group?.querySelector<HTMLElement>(".settings-theme-import__inline-hint");
                  if (hint) hint.hidden = true;
                  button.setAttribute("aria-expanded", "true");
                  form.querySelector<HTMLInputElement>("input")?.focus();
                }}>
                <span class="settings-theme-card__icon" aria-hidden="true">${icons.download}</span><span class="settings-theme-card__label">Import</span>
              </button>
            </div>
          </div>`
        : nothing
    }
    ${renderRow(
      "Color mode",
      selectable
        ? "Follows your system setting unless you pick one."
        : `This theme only carries a ${props.variant} variant, so the mode follows the theme.`,
      html`
        <div class="settings-segmented" role="group" aria-label="Color mode">
          ${THEME_MODES.map(
            (mode) => html`
              <button
                type="button"
                class="settings-segmented__btn ${mode === shownMode ? "settings-segmented__btn--active" : ""}"
                aria-pressed=${String(mode === shownMode)}
                ?disabled=${!selectable}
                @click=${() => props.onSelectMode(mode)}
              >
                ${MODE_LABELS[mode]}
              </button>
            `,
          )}
        </div>
      `,
    )}
    ${renderImportRow(props)}
  `;
  return renderSection(
    "Theme",
    props.previews.length > 0
      ? "Choose a theme family for this Control UI client."
      : "No themes could be loaded; the built-in defaults are in use.",
    body,
  );
}

const ACCENTS = [
  { id: "default", label: "Theme default", value: "" },
  { id: "claw", label: "Claw red", value: "#ff5c5c" },
  { id: "coral", label: "Coral", value: "#ff8066" },
  { id: "amber", label: "Amber", value: "#f5b942" },
  { id: "mint", label: "Mint", value: "#52c99a" },
  { id: "teal", label: "Teal", value: "#35b9b0" },
  { id: "blue", label: "Blue", value: "#5b9cf6" },
  { id: "violet", label: "Violet", value: "#a78bfa" },
  { id: "pink", label: "Pink", value: "#f472b6" },
  { id: "slate", label: "Slate gray", value: "#8795a8" },
] as const;

function renderAccentSection(props: SettingsProps) {
  const inherited = props.previews.find((preview) => preview.id === props.themeId)?.accent ?? "var(--accent)";
  const preset = ACCENTS.find((item) => item.value === props.settings.accent);
  const custom = Boolean(props.settings.accent && !preset);
  return renderSection(
    "Accent",
    "Choose the accent color used by buttons, highlights and focus controls.",
    html`
      <div class="settings-row settings-row--stacked">
        <div class="settings-accent-swatches" role="group" aria-label="Accent color">
          ${ACCENTS.map((item) => html`<button
            type="button"
            class="settings-accent-swatch ${props.settings.accent === item.value ? "settings-accent-swatch--active" : ""}"
            style=${`--settings-accent-swatch: ${item.value || inherited}`}
            aria-label=${item.label}
            aria-pressed=${String(props.settings.accent === item.value)}
            title=${item.label}
            @click=${() => props.onSelectAccent(item.value)}
          >${props.settings.accent === item.value
            ? html`<span class="settings-accent-swatch__check" aria-hidden="true">${icons.check}</span>`
            : item.id === "default"
              ? html`<span class="settings-accent-swatch__reset" aria-hidden="true">${icons.rotateCcw}</span>`
              : nothing}</button>`)}
          <label
            class="settings-accent-swatch settings-accent-swatch--custom ${custom ? "settings-accent-swatch--active" : ""}"
            style=${`--settings-accent-swatch: ${props.settings.accent || "#ff5c5c"}`}
            title="Custom color"
          >
            <input class="settings-accent-swatch__input" type="color" aria-label="Custom accent color" .value=${props.settings.accent || "#ff5c5c"}
              @change=${(event: Event) => props.onSelectAccent((event.currentTarget as HTMLInputElement).value)} />
            <span class="settings-accent-swatch__picker" aria-hidden="true">${icons.pipette}</span>
          </label>
        </div>
      </div>
      <div class="settings-row">
        <div class="settings-row__text"><span class="settings-row__title">Current accent</span><span class="settings-row__desc">Saved locally in HUI and applied over the active theme.</span></div>
        <div class="settings-row__control"><span class="settings-row__value">${preset?.label ?? "Custom color"}</span></div>
      </div>
    `,
  );
}

function renderLanguageSection() {
  return renderSection(
    "Language",
    "",
    renderRow(
      "Language",
      "Default: System. Saved locally for this browser.",
      html`<wa-select class="settings-select" size="s" value="system" disabled>
        <span slot="label" class="settings-control__sr-label">Language</span>
        <wa-option value="system">System</wa-option>
      </wa-select>`,
    ),
  );
}

const terminalFontOptions = TERMINAL_FONTS.map((font) => ({
  value: font,
  label: font,
  labelStyle: `font-family: ${terminalFontStack(font)}`,
}));

function renderFontSection(props: SettingsProps) {
  const options = TYPEFACES.map((face) => ({
    value: face.id,
    label: face.label,
    description: face.note,
    labelStyle: `font-family: ${face.stack}`,
  }));
  return renderSection(
    "Typography",
    "",
    html`
      ${renderRow(
        "Interface",
        "Chrome, navigation, settings, and controls.",
        renderPicker({
          id: "settings-font-ui",
          label: "Interface font",
          value: props.settings.fontUi,
          options,
          searchable: true,
          onChange: (fontUi) => props.onChangeAppearance({
            fontUi: fontUi as Settings["fontUi"],
            fontChat: props.settings.fontChat,
            textScale: props.settings.textScale,
          }),
        }),
      )}
      ${renderRow(
        "Chat prose",
        "Conversation messages and reading surfaces.",
        renderPicker({
          id: "settings-font-chat",
          label: "Chat prose font",
          value: props.settings.fontChat,
          options,
          searchable: true,
          onChange: (fontChat) => props.onChangeAppearance({
            fontUi: props.settings.fontUi,
            fontChat: fontChat as Settings["fontChat"],
            textScale: props.settings.textScale,
          }),
        }),
      )}
      ${renderRow(
        "Terminal",
        "Monospace or Nerd Font installed on this device. Type to use any family name.",
        renderPicker({
          id: "settings-font-terminal",
          label: "Terminal font",
          value: props.settings.fontTerminal,
          options: terminalFontOptions,
          searchable: true,
          searchPlaceholder: "Search or type a font name",
          customOption: (query) => normalizeTerminalFont(query) === query
            ? { value: query, label: query, description: "Use this local font", labelStyle: `font-family: ${terminalFontStack(query)}` }
            : null,
          onChange: (fontTerminal) => props.onChangeAppearance({ fontTerminal }),
        }),
      )}
      <div class="settings-row settings-row--stacked">
        <div class="settings-typography-preview">
          <div class="settings-typography-preview__caption">HUI · A little clarity goes a long way</div>
          <p class="settings-typography-preview__prose">
            Good typography makes room for the conversation. Choose a face that feels comfortable to read.
          </p>
          <code class="settings-typography-preview__code">const greeting = "Hello, world!";</code>
          <div style=${`font-family: ${terminalFontStack(props.settings.fontTerminal)}; margin-top: 16px; overflow-wrap: anywhere;`} aria-label="Terminal font preview">❯ ~/project ⎇ main &#xe0b0; &#xf07c; &#xf120; git status</div>
        </div>
      </div>
    `,
  );
}

function renderTextSizeSection(props: SettingsProps) {
  return renderSection(
    "Text size",
    "Scales every text size in the interface together. Using default: 100%.",
    html`<div class="settings-row settings-row--stacked">
      <div class="settings-text-scale">
        <div class="settings-text-scale__options" role="group" aria-label="Text size">
          ${TEXT_SCALE_STOPS.map(
            (stop) => html`
              <button
                type="button"
                class="settings-text-scale__btn ${stop === props.settings.textScale ? "active" : ""}"
                aria-pressed=${String(stop === props.settings.textScale)}
                @click=${() => props.onChangeAppearance({
                  fontUi: props.settings.fontUi,
                  fontChat: props.settings.fontChat,
                  textScale: stop,
                })}
              >
                <span class="settings-text-scale__sample">${SCALE_LABELS[stop]}</span>
                <span class="settings-text-scale__label">${stop}%</span>
              </button>
            `,
          )}
        </div>
      </div>
    </div>`,
  );
}

function renderChatSection(props: SettingsProps) {
  const chat = props.settings.chat;
  return renderSection(
    "Chat",
    "Composer and conversation preferences. Stored for this HUI client.",
    html`
      ${renderRow(
        "Message width",
        "Controls the maximum width of the conversation and composer.",
        renderSettingsPicker("Message width", chat.messageWidth,
          [{ value: "compact", label: "Compact" }, { value: "comfortable", label: "Comfortable" }, { value: "wide", label: "Wide" }],
          (value) => props.onChangeChat({ ...chat, messageWidth: value as Settings["chat"]["messageWidth"] })),
      )}
      ${renderRow(
        "Collapse task progress",
        "Start active task progress cards collapsed.",
        renderSettingsToggle("Collapse task progress", chat.collapseTaskProgress,
          (checked) => props.onChangeChat({ ...chat, collapseTaskProgress: checked })),
      )}
      ${renderRow(
        "Send shortcut",
        "Choose whether Enter sends or inserts a new line.",
        renderSettingsPicker("Send shortcut", chat.sendShortcut,
          [{ value: "enter", label: "Enter" }, { value: "modifierEnter", label: "⌘/Ctrl + Enter" }],
          (value) => props.onChangeChat({ ...chat, sendShortcut: value as Settings["chat"]["sendShortcut"] })),
      )}
      ${renderRow(
        "GitHub link previews",
        "Show up to three cards for GitHub repositories, pull requests and issues after a message, using the GitHub login from Integrations.",
        renderSettingsToggle("GitHub link previews", chat.githubEmbeds,
          (checked) => props.onChangeChat({ ...chat, githubEmbeds: checked })),
      )}
      ${renderRow(
        "Datadog link previews",
        "Show up to three cards for Datadog share links and dashboard widgets after a message, through the orgs in Integrations. Drawing a widget makes Datadog keep a snapshot image at an unguessable link, as its own sharing does.",
        renderSettingsToggle("Datadog link previews", chat.datadogEmbeds,
          (checked) => props.onChangeChat({ ...chat, datadogEmbeds: checked })),
      )}
    `,
  );
}

/**
 * The pi-backed pages. Everything here is read from pi's own configuration, so
 * there is nothing to save: the dashboard reports, pi decides.
 */
export type PiSettingsState = "loading" | "error" | "ready" | "missing";

export function piSettingsState(props: Pick<SettingsProps, "pi" | "piLoading" | "piError">): PiSettingsState {
  if (props.pi) return "ready";
  if (props.piLoading) return "loading";
  if (props.piError) return "error";
  return "missing";
}

function renderPiMissing(props: SettingsProps) {
  const state = piSettingsState(props);
  if (state === "loading") {
    return html`<p class="settings-page__note settings-page__intro" role="status">Reading pi configuration…</p>`;
  }
  if (state === "error") {
    return html`
      <div class="settings-page__note settings-page__intro" role="alert">
        <p>Could not read pi configuration: ${props.piError}</p>
        <button type="button" class="btn" @click=${props.onRetryPi}>Retry</button>
      </div>
    `;
  }
  return html`<p class="settings-page__note settings-page__intro">Pi configuration has not been loaded yet.</p>`;
}

function renderPiOrigin(props: SettingsProps) {
  if (!props.pi) {
    return nothing;
  }
  return html`${props.piError ? html`<div class="settings-page__note settings-page__intro" role="alert">Refresh failed: ${props.piError}</div>` : nothing}<p class="settings-page__note settings-page__intro">
    Read from <code>${props.pi.settings.path}</code>
    ${props.pi.settings.exists ? nothing : html`(not written yet, so pi is on its defaults)`}.
    HUI never writes here.
  </p>`;
}

function renderPiOperation(props: SettingsProps, kind: PiMutationState["kind"]) {
  const operation = props.piOperation;
  if (!operation || operation.kind !== kind) return nothing;
  return html`<div class="settings-page__note settings-page__intro pi-operation pi-operation--${operation.status}" role=${operation.status === "error" ? "alert" : "status"}>
    <strong>${operation.status === "running" ? "Working…" : operation.status === "ok" ? "OK" : "Error"}</strong>
    <span>${operation.message}</span>
  </div>`;
}

function renderPiUrlForm(
  props: SettingsProps,
  label: string,
  placeholder: string,
  button: string,
  submit: (url: string) => void,
) {
  const running = props.piOperation?.status === "running";
  return html`<form class="settings-row pi-install-form" @submit=${(event: SubmitEvent) => {
    event.preventDefault();
    submit(String(new FormData(event.currentTarget as HTMLFormElement).get("url") ?? "").trim());
  }}>
    <div class="settings-row__text">
      <span class="settings-row__title">${label}</span>
      <span class="settings-row__desc">${label === "Skill URL" ? "Use a clean HTTPS URL containing an Agent Skill." : "PI installs the matching npm source."}</span>
    </div>
    <div class="settings-row__control">
      <input class="settings-input" name="url" aria-label=${label} type="url" inputmode="url" autocomplete="url" placeholder=${placeholder} ?disabled=${running} />
      <button type="submit" class="btn" ?disabled=${running}>${button}</button>
    </div>
  </form>`;
}

function renderSkillsPage(props: SettingsProps) {
  const pi = props.pi;
  if (!pi) {
    return renderPiMissing(props);
  }
  return html`
    <p class="settings-page__intro">
      PI skills and HUI defaults. Disable one to hide it from HUI runtimes while keeping its files
      and PI configuration intact. Changes apply when a session runtime next starts.
    </p>
    ${renderSection(
      "Install from URL",
      "A short-lived low-cost PI agent installs one skill and HUI verifies that PI discovers it.",
      renderPiUrlForm(props, "Skill URL", "https://github.com/owner/skill", "Install skill", props.onInstallSkill),
    )}
    ${renderPiOperation(props, "skill-install")}
    ${pi.skills.length ? renderListFilter("Search skills") : nothing}
    ${renderSection(
      "Installed skills",
      pi.skills.length === 1 ? "1 skill available" : `${pi.skills.length} skills available`,
      pi.skills.length === 0
        ? renderRow(
            "No skills found",
            `Searched ${pi.settings.skillRoots.join(", ")}`,
            html`<span class="settings-row__muted">—</span>`,
          )
        : html`<div>
            ${pi.skills.map(
              (skill) => {
                const enabled = skillIsEnabled(skill, props.settings.disabledSkills);
                return html`
                <article class="settings-row plugins-item" data-filter=${`${skill.name} ${skill.description} ${skill.tags?.join(" ") ?? ""}`}>
                  <div class="settings-row__text" title=${skill.path}>
                    <span class="settings-row__title">${skill.name} ${skill.tags?.map((tag) => html`<span class="capability-badge">${tag}</span>`)}</span>
                    <span class="settings-row__desc">${skill.description || "No description provided."}</span>
                    ${skill.origin === "hui" ? html`<span class="settings-row__desc">Included with HUI · enabled by default · optional</span>` : nothing}
                  </div>
                  <div class="settings-row__control pi-package-actions">
                    <button type="button" class="btn btn--icon pi-resource-read-button" aria-label=${`Read ${skill.name}`} title=${`Read ${skill.name}`} @click=${() => props.onReadSkill(skill)}>${icons.eye}</button>
                    ${skill.origin === "hui" ? nothing : html`<a class="btn btn--icon pi-resource-read-button" href=${`vscode://file${skill.path.split("/").map(encodeURIComponent).join("/")}`} aria-label=${`Edit ${skill.name} in VS Code`} title=${`Edit ${skill.name} in VS Code`}>${icons.edit}</a>`}
                    ${renderSettingsToggle(
                      `Enable ${skill.name} in HUI`,
                      enabled,
                      (checked) => props.onSetSkillEnabled(skill, checked),
                    )}
                  </div>
                </article>
              `;
              },
            )}
          </div>`,
    )}
    ${renderPiOrigin(props)}
  `;
}

/** One section per external service: Jira, GitHub, then Datadog. */
function renderIntegrationsPage() {
  return html`
    <p class="settings-page__intro">Connect HUI to external services. Credentials stay on this machine and are never sent to the browser.</p>
    <hui-jira-settings></hui-jira-settings>
    <hui-github-settings></hui-github-settings>
    <hui-datadog-settings></hui-datadog-settings>
  `;
}

function renderToolsPage(props: SettingsProps) {
  return html`
    <p class="settings-page__intro">HUI owns the tools, the managed browser, the VS Code server and the default prompt. Inspect the shipped catalog without opening a session, or inspect an already-running session.</p>
    <hui-browser-settings .settings=${props.settings.browser} .onChange=${props.onChangeBrowser}></hui-browser-settings>
    <section class="settings-section" data-settings-section="codemode">
      <div class="settings-section__header"><div class="settings-section__copy">
        <h2 class="settings-section__heading">Codemode</h2>
        <p class="settings-section__desc">Agents can write one JavaScript script that calls their other tools, several at once, and get back only what the script prints. The chat shows each script as one card with the calls it made.</p>
      </div></div>
      <div class="settings-group"><div class="settings-row">
        <div class="settings-row__text">
          <span class="settings-row__title">Codemode tool</span>
          <span class="settings-row__desc">Offer codemode to every session, from its next request. A script that is already running finishes. Sessions still on the older PI worker don't get it.</span>
        </div>
        <div class="settings-row__control">${renderSettingsToggle("Codemode tool", props.settings.codemode.enabled, (enabled) => props.onChangeCodemode({ enabled }))}</div>
      </div></div>
    </section>
    ${renderSection("Questions", "When an agent asks you questions in a card and you are away, it can go on without your answer.", renderRow(
      "Question timeout",
      "How long a question card waits for you. Then the agent continues without your answer, told to take its recommended option and list the decisions still open for you in its final reply. Applies to questions asked from now on.",
      renderSettingsPicker("Question timeout", String(props.settings.questions.timeoutMinutes),
        QUESTION_TIMEOUTS.map((minutes) => ({ value: String(minutes), label: minutes ? `${minutes} minutes` : "Off" })),
        (value) => props.onChangeQuestions({ timeoutMinutes: Number(value) })),
    ))}
    <hui-vscode-settings .settings=${props.settings.vscode} .onChange=${props.onChangeVscode}></hui-vscode-settings>
    ${renderListFilter("Search tools")}
    <hui-tools-settings .sessions=${props.sessions.filter((session) => !session.bot)}></hui-tools-settings>`;
}

/** Settings → Models → Calls: GPT-Live through the ChatGPT login above (HUI-18). */
function renderCallsSection(props: SettingsProps) {
  return html`<hui-call-settings .calls=${props.settings.calls} .onChange=${props.onChangeCalls}></hui-call-settings>`;
}

function renderModelsPage(props: SettingsProps) {
  const pi = props.pi;
  if (!pi) {
    return html`<hui-provider-settings @providers-changed=${props.onRetryPi}></hui-provider-settings>${renderCallsSection(props)}${renderPiMissing(props)}`;
  }
  const model = pi.model;
  const modelOptions = [
    { value: "", label: "Use PI default" },
    ...model.catalog.map((entry) => ({ value: `${entry.provider}/${entry.id}`, label: entry.name })),
  ];
  const routePicker = (label: string, key: keyof Settings["models"]) =>
    renderSettingsPicker(label, props.settings.models[key], modelOptions, (value) => {
      props.onChangeModels({ ...props.settings.models, [key]: value });
    });
  return html`
    <p class="settings-page__intro">
      Connect providers and choose models without changing PI's configuration. Three roles: the primary model does the real work, the utility model the quick work, and GPT-Live (Calls, below) talks on calls.
    </p>
    <hui-provider-settings @providers-changed=${props.onRetryPi}></hui-provider-settings>
    ${renderSection(
      "HUI model routing",
      "Saved by HUI and applied to new sessions.",
      html`
        ${renderRow(
          "Primary model",
          `The smartest model you have. Speed doesn't matter: it does the real work of new sessions and bots.`,
          routePicker("Primary model", "primary"),
        )}
        ${renderRow(
          "Fallback model",
          "Tried when the primary fails before producing useful output. Example: Anthropic Sonnet when OpenAI is unavailable.",
          routePicker("Fallback model", "fallback"),
        )}
        ${renderRow(
          "Utility model",
          `The fastest model you have, ideally a cheap one. It names sessions and branches, drafts Jira items and answers /btw; for bots without their own, it writes memory summaries, answers quick questions on calls and writes call summaries.`,
          routePicker("Utility model", "utility"),
        )}
      `,
    )}
    ${renderCallsSection(props)}
    ${renderSection(
      "PI defaults",
      "Read-only fallbacks used when HUI has no primary route.",
      html`
        ${renderRow(
          "Provider",
          "pi's default provider.",
          html`<span class="settings-row__value">${model.defaultProvider || "pi default"}</span>`,
        )}
        ${renderRow(
          "Model",
          "pi's default model.",
          html`<span class="settings-row__value">${model.defaultModel || "pi default"}</span>`,
        )}
        ${renderRow(
          "Thinking level",
          "Reasoning budget for a new session.",
          html`<span class="settings-row__value">${model.thinking ?? "pi default"}</span>`,
        )}
      `,
    )}
    ${renderSection(
      "Cycling models",
      model.enabled.length === 0
        ? "Not configured, so pi cycles through its own list."
        : `${model.enabled.length} pattern${model.enabled.length === 1 ? "" : "s"}`,
      model.enabled.length === 0
        ? renderRow(
            "No patterns set",
            "Add `enabledModels` to pi's settings to control Ctrl+P cycling.",
            html`<span class="settings-row__muted">—</span>`,
          )
        : html`${model.enabled.map((pattern) => renderRow(pattern, "Enabled model pattern", html`<span class="settings-row__muted">Configured</span>`))}`,
    )}
    ${renderSection(
      "PI credential sources",
      model.authenticated.length === 0
        ? "No provider credentials found."
        : "PI credential sources, separate from HUI-managed connections. Secret values never appear here.",
      model.authenticated.length === 0
        ? renderRow(
            "None",
            `Expected in ${pi.agentDir}/auth.json`,
            html`<span class="settings-row__muted">—</span>`,
          )
        : html`${model.authenticated.map((name) => renderRow(name, "Credential source present; values remain private.", html`<span class="settings-row__muted">Configured</span>`))}`,
    )}
    <details class="hui-provider-catalog"><summary>Available catalog · ${model.catalog.length} models</summary>
    ${renderSection(
      "Available catalog",
      model.catalog.length === 0
        ? "No available models match your PI configuration."
        : `${model.catalog.length} available model${model.catalog.length === 1 ? "" : "s"}. Includes HUI selections and PI custom providers.`,
      model.catalog.length === 0
        ? renderRow("No models", "Check PI provider configuration and refresh.", html`<span class="settings-row__muted">—</span>`)
        : html`${model.catalog.map((entry) => renderRow(entry.name, `${entry.provider}/${entry.id}`, html`<span class="settings-row__muted">${entry.contextWindow ? `${entry.contextWindow.toLocaleString()} context` : "Context not reported"}${entry.maxTokens ? ` · ${entry.maxTokens.toLocaleString()} max output` : ""}</span>`))}`,
    )}
    </details>
    ${pi.diagnostics.length > 0
      ? renderSection(
          "Diagnostics",
          "Problems reading pi's configuration.",
          html`${pi.diagnostics.map((note) => renderRow("Configuration diagnostic", note, html`<span class="settings-row__muted">Review</span>`))}`,
        )
      : nothing}
    ${renderPiOrigin(props)}
  `;
}

const POWER_PILLS: Record<PowerState["state"], { label: string; tone: string }> = {
  off: { label: "Off", tone: "" },
  pending: { label: "Pending", tone: "warn" },
  active: { label: "Active", tone: "ok" },
  error: { label: "Failed", tone: "danger" },
};

/** The switch is the operator's choice; the pill is what the gateway actually holds. */
function renderPowerRow(title: string, notes: TemplateResult, status: PowerState, checked: boolean, onChange: (checked: boolean) => void) {
  const pill = POWER_PILLS[status.state];
  return html`
    <div class="settings-row power-row">
      <div class="settings-row__text">
        <span class="settings-row__title">${title}</span>
        ${notes}
        ${status.detail ? html`<span class="settings-row__desc">${status.detail}</span>` : nothing}
      </div>
      <div class="settings-row__control">
        <span class="settings-status ${pill.tone ? `settings-status--${pill.tone}` : ""}" role="status"><span class="settings-status__dot" aria-hidden="true"></span>${pill.label}</span>
        ${renderSettingsToggle(title, checked, onChange)}
      </div>
    </div>
  `;
}

function renderPowerSection(props: SettingsProps, status: PowerStatus) {
  const power = props.settings.power;
  return renderSection("Power", "macOS only. Both apply only while this gateway is running.", html`
    ${renderPowerRow(
      "Keep Mac awake",
      html`<span class="settings-row__desc">Prevents idle sleep, like <code>caffeinate -i</code>. The display can still turn off.</span>`,
      status.keepAwake,
      power.keepAwake,
      (keepAwake) => props.onChangePower({ ...power, keepAwake }),
    )}
    ${renderPowerRow(
      "Stay awake with the lid closed",
      html`<span class="settings-row__desc">Like <code>sudo pmset -a disablesleep 1</code>. Lasts until you turn it off or the gateway stops; every gateway start begins with it off.</span>
        <span class="settings-row__desc"><strong>Requires administrator permission.</strong> macOS asks for your password each time you turn this on.</span>`,
      status.lidAwake,
      status.lidOn,
      props.onSetLidAwake,
    )}
  `);
}

export function renderConnectionPage(props: SettingsProps) {
  const health = props.health;
  const failed = Boolean(props.healthError);
  const tone = failed ? "danger" : health ? "ok" : "warn";
  const label = failed ? "Disconnected" : health ? "Connected" : "Connecting…";
  return html`
    <p class="settings-page__intro">Gateway access and live PI runtime state.</p>
    ${renderSection(
      "Access",
      "Connection checked every 3 seconds while this page is visible.",
      html`${renderRow("Gateway", health?.transport ?? "The HUI backend serving this page.", html`<span class="settings-status gateway-status gateway-status--${tone}" role="status"><span class="settings-status__dot" aria-hidden="true"></span>${label}</span>`)}
        ${renderRow("Permissions", "HUI does not add approval prompts.", html`<span class="settings-row__value">${health?.access ?? "Full Access"}</span>`)}`,
    )}
    ${failed ? html`<div class="settings-page__note settings-page__intro gateway-error" role="alert">Could not reach gateway: ${props.healthError}<button type="button" class="btn" @click=${props.onRetryPi}>Retry connection</button></div>` : nothing}
    ${health ? renderSection(
      "Runtime",
      failed ? "Last known values · waiting to reconnect." : "Live process state · updates automatically.",
      html`${renderRow("Uptime", "Current gateway process.", html`<span class="settings-row__value gateway-metric" title=${`${health.uptimeSeconds} seconds`}>${formatGatewayUptime(health.uptimeSeconds)}</span>`)}
        ${renderRow("Registered sessions", "HUI session registry.", html`<span class="settings-row__value gateway-metric">${health.sessions.registered.toLocaleString()}</span>`)}
        ${renderRow("Running", "PI sessions processing a turn.", html`<span class="settings-status gateway-status gateway-status--${failed || !health.sessions.running ? "idle" : "ok"}"><span class="settings-status__dot" aria-hidden="true"></span>${health.sessions.running ? `${health.sessions.running.toLocaleString()} active` : "Idle"}</span>`)}`,
    ) : nothing}
    ${props.power ? renderPowerSection(props, props.power) : nothing}
    ${renderPiOrigin(props)}
  `;
}

function renderPluginsPage(props: SettingsProps) {
  const pi = props.pi;
  if (!pi) return renderPiMissing(props);
  const resources = pi.settings.resources;
  return html`
    <p class="settings-page__intro">PI packages and extension sources. Disable one to exclude it from new HUI SDK runtimes without uninstalling it or changing PI settings.</p>
    ${renderSection(
      "Add package",
      "Paste a package page from pi.dev/packages.",
      renderPiUrlForm(props, "pi.dev package URL", "https://pi.dev/packages/package-name", "Install package", props.onInstallPackage),
    )}
    ${renderPiOperation(props, "package-install")}
    ${renderPiOperation(props, "package-remove")}
    ${resources.length ? renderListFilter("Search plugins") : nothing}
    ${renderSection(
      "Installed",
      resources.length ? `${resources.length} configured source${resources.length === 1 ? "" : "s"}` : "No packages or extensions configured.",
      resources.length
        ? html`<div>${resources.map((resource) => {
          const enabled = !props.settings.disabledPlugins.some((entry) => entry.id === resource.id);
          return html`<article class="settings-row plugins-item" data-filter=${resource.label}><div class="settings-row__text"><span class="settings-row__title">${resource.label}</span><span class="settings-row__desc">${resource.kind === "package" ? "Managed by PI" : "Direct extension"} · applies on next runtime start</span></div><div class="settings-row__control pi-package-actions">
            <button type="button" class="btn btn--icon pi-resource-read-button" aria-label=${`Read ${resource.label}`} title=${`Read ${resource.label}`} @click=${() => props.onReadPlugin(resource)}>${icons.eye}</button>
            ${renderSettingsToggle(`Enable ${resource.label} in HUI`, enabled, (checked) => props.onSetPluginEnabled(resource, checked))}
            ${resource.kind === "package" ? props.piRemoveCandidate === resource.label
              ? html`<button type="button" class="btn" @click=${props.onCancelRemovePackage}>Cancel</button><button type="button" class="btn danger" ?disabled=${props.piOperation?.status === "running"} @click=${() => props.onConfirmRemovePackage(resource.label)}>Remove</button>`
              : html`<button type="button" class="btn" ?disabled=${props.piOperation?.status === "running"} @click=${() => props.onRequestRemovePackage(resource.label)} aria-label=${`Remove ${resource.label}`}>Remove</button>`
              : nothing}
          </div></article>`;
        })}</div>`
        : renderRow("No extensions", "Add a package from pi.dev above.", html`<span class="settings-row__muted">—</span>`),
    )}
    ${props.piError ? html`<div class="settings-page__note settings-page__intro" role="alert">Refresh failed: ${props.piError}<button type="button" class="btn" @click=${props.onRetryPi}>Retry</button></div>` : nothing}
  `;
}

function renderMemoryPage(props: SettingsProps) {
  const data = props.workspaces;
  if (!data) return html`<div class="settings-page__note settings-page__intro" role=${props.workspaceError ? "alert" : "status"}>${props.workspaceError || "Reading workspace inventory…"}${props.workspaceError ? html`<button type="button" class="btn" @click=${props.onRetryPi}>Retry</button>` : nothing}</div>`;
  return html`
    <p class="settings-page__intro">Workspace-local context and memory inventory. Nothing is copied into PI or OpenClaw.</p>
    ${renderSection(
      "Sources",
      data.memory.length ? `${data.memory.length} file${data.memory.length === 1 ? "" : "s"} discovered` : "No workspace memory sources found.",
      data.memory.length
        ? html`<div>${data.memory.map((source) => renderRow(source.relativePath, source.workspace, html`<span class="settings-row__value">${source.kind}</span>`))}</div>`
        : renderRow("Nothing found", "Only workspaces already registered by HUI are inspected.", html`<span class="settings-row__muted">—</span>`),
    )}
    ${props.workspaceError ? html`<div class="settings-page__note settings-page__intro" role="alert">Refresh failed: ${props.workspaceError}</div>` : nothing}
    <p class="settings-page__note settings-page__intro">Read-only: HUI has no invented long-term-memory store.</p>
  `;
}

function renderAppearancePage(props: SettingsProps) {
  return html`
    <p class="settings-page__intro">
      Theme, chat, and sidebar preferences for this Control UI client.
    </p>
    ${renderLanguageSection()} ${renderThemeSection(props)} ${renderAccentSection(props)} ${renderFontSection(props)}
    ${renderTextSizeSection(props)} ${renderChatSection(props)}
    <p class="settings-page__note settings-page__intro">
      ${props.saveFailed
        ? "Could not write settings.json — changes apply now but will not be remembered."
        : "Saved to ~/.config/hui/settings.json"}
    </p>
  `;
}

function renderDiagnosticsPage(props: SettingsProps) {
  const snapshot = props.observability;
  if (!snapshot) return html`<div class="settings-page__note settings-page__intro" role=${props.observabilityError ? "alert" : "status"}>${props.observabilityError || "Reading diagnostics…"}<button type="button" class="btn" @click=${props.onRefreshObservability}>Retry</button></div>`;
  return html`<p class="settings-page__intro">Runtime logs, activity, health and a redacted diagnostic export.</p>
    ${renderSection("Gateway", "Current process-level diagnostic state.", html`
      ${renderRow("Runtime", `${snapshot.debug.platform} · ${snapshot.debug.node}`, html`<span class="settings-row__value">Online</span>`)}
      ${renderRow("Activity retention", "Best-effort in-memory operational metadata.", html`<span>${snapshot.debug.eventCount} / ${snapshot.retention.maximum}</span>`)}
      ${renderRow("Usage metadata", "Aggregated without transcript content.", html`<span>${snapshot.usage.totalTokens.toLocaleString()} tokens</span>`)}
    `)}
    ${renderSection("Export", "Prompts, tool payloads, credentials and secret values are excluded.", html`<div class="settings-row"><div class="settings-row__text"><span class="settings-row__title">Diagnostic snapshot</span><span class="settings-row__desc">JSON generated from the same bounded snapshot shown in HUI.</span></div><div class="settings-row__control"><button type="button" class="btn" @click=${props.onExportDiagnostics}>Export JSON</button></div></div>`)}
    ${props.observabilityError ? html`<div class="settings-page__note settings-page__intro" role="alert">${props.observabilityError}</div>` : nothing}`;
}

function renderWorktreesSettingsPage(props: SettingsProps) {
  return html`${renderWorktreesPage(props.worktrees)}
    ${renderSection("Git worktrees", "New Session can create an isolated checkout from the selected repository.", html`
      ${renderRow("Default branch prefix", "Saved for future worktree branches; a trailing slash is added automatically.", html`
        <form class="row" @submit=${(event: SubmitEvent) => {
          event.preventDefault();
          const form = event.currentTarget;
          if (!(form instanceof HTMLFormElement)) return;
          const field = form.elements.namedItem("branchPrefix");
          if (field instanceof HTMLInputElement) props.onChangeBranchPrefix(field.value);
        }}>
          <input class="settings-input settings-input--prefix" name="branchPrefix" aria-label="Workspace branch prefix" spellcheck="false" autocomplete="off" .value=${props.settings.branchPrefix} />
          <button type="submit" class="btn">Save</button>
        </form>
      `)}
    `, "branch-prefix")}`;
}

function renderSecurityPage(props: SettingsProps) {
  const authenticated = props.pi?.model.authenticated ?? [];
  return html`<p class="settings-page__intro">Local exposure, credential boundaries and diagnostic privacy.</p>
    ${renderSection("Access", "HUI keeps the agreed Full Access runtime model without an approval interception layer.", html`
      ${renderRow("Runtime permissions", "HUI delegates tool execution to the configured PI runtime.", html`<span class="settings-row__value">${props.health?.access ?? "Full Access"}</span>`)}
      ${renderRow("Browser API guard", "Every /__hui/ request requires the local-client header; cross-origin preflights are refused.", html`<code>x-hui: 1</code>`)}
      ${renderRow("Transport", "This gateway reports its active browser transport.", html`<span>${props.health?.transport ?? "Reading…"}</span>`)}
    `)}
    ${renderSection("Credentials", "PI remains the source of truth. HUI never returns or stores credential values.", html`
      ${renderRow("PI credential sources", authenticated.length ? authenticated.join(", ") : "No provider names reported.", html`<strong>${authenticated.length}</strong>`)}
      ${renderRow("Secrets", "Only provider names and safe availability metadata reach the browser.", html`<span class="settings-row__value">Values redacted</span>`)}
    `)}
    ${renderSection("Diagnostics", "Exports are bounded operational metadata, not transcript archives.", html`
      ${renderRow("Excluded", "Prompts, transcript content, tool arguments/output and secret values.", html`<span class="settings-row__value">Enforced</span>`)}
      ${renderRow("Retention", "Activity is held in memory for the current gateway process only.", html`<span>${props.observability?.retention.maximum ?? 300} events max</span>`)}
    `)}
    ${props.piError || props.healthError ? html`<div class="settings-page__note settings-page__intro" role="alert">${[props.piError, props.healthError].filter(Boolean).join(" ")}<button type="button" class="btn" @click=${props.onRetryPi}>Retry</button></div>` : nothing}`;
}

const SETTINGS_SUMMARIES: Record<Exclude<SettingsPage, "appearance" | "skills" | "tools" | "models" | "automation" | "security" | "worktrees" | "workers">, string> = {
  connection: "HUI server, local PI runtime, reconnect behaviour and health.",
  integrations: "Connections to external services such as Jira and GitHub.",
  plugins: "Packages, extensions, permissions and provider adapters.",
  memory: "Workspace memory files, search, import and indexing.",
  diagnostics: "Runtime logs, activity, health and exportable reports.",
};

export function adaptedSettingsCopy(page: keyof typeof SETTINGS_SUMMARIES) {
  const label = SETTINGS_PAGES.find((item) => item.id === page)?.label ?? page;
  return {
    label,
    summary: SETTINGS_SUMMARIES[page],
    description: "This settings region is accepted for adaptation to PI/HUI, but its controls are not implemented yet.",
  };
}

function renderPendingSettingsPage(page: keyof typeof SETTINGS_SUMMARIES) {
  const copy = adaptedSettingsCopy(page);
  return html`
    <p class="settings-page__intro">${copy.summary}</p>
    ${renderSection(
      copy.label,
      copy.description,
      html`
        ${renderRow("Decision", "This region is part of the accepted HUI roadmap.", html`<span class="settings-row__value">Accepted</span>`)}
        ${renderRow("Backend", "No controls or writes are available yet.", html`<span class="settings-row__muted">Not implemented</span>`)}
      `,
    )}
  `;
}

export function renderSettingsPage(props: SettingsProps) {
  return html`
    <aside class="shell-nav settings-sidebar settings-nav" data-open=${String(SETTINGS_DRAWER_DEFAULT_OPEN)} @keydown=${(event: KeyboardEvent) => handleSettingsEscape(event, props)}>
      <button
        type="button"
        class="settings-mobile-topbar"
        aria-label="Open settings navigation"
        aria-controls="settings-navigation-drawer"
        aria-expanded="false"
        @click=${toggleSettingsDrawer}
      >
        <span aria-hidden="true">☰</span>
        <span>Settings</span>
        <strong>${SETTINGS_PAGES.find((page) => page.id === props.page)?.label}</strong>
      </button>
      <button
        type="button"
        class="settings-backdrop"
        aria-label="Close settings navigation"
        @click=${(event: Event) => closeSettingsDrawer(event, true)}
      ></button>
      <div class="settings-sidebar__drawer" id="settings-navigation-drawer">
      <header class="settings-sidebar__header">
        <button
          type="button"
          class="settings-sidebar__back settings-nav__back"
          @click=${props.onClose}
        >
          <span class="settings-sidebar__back-icon" aria-hidden="true">${icons.arrowLeft}</span>
          Exit Settings
          <kbd class="settings-sidebar__esc" aria-hidden="true">esc</kbd>
        </button>
        <h1 class="settings-sidebar__title settings-nav__title">Settings</h1>
      </header>
      <div class="settings-sidebar__search" role="search">
        <span class="settings-sidebar__search-icon" aria-hidden="true">${icons.search}</span>
        <input
          class="settings-sidebar__search-input"
          type="search"
          autocomplete="off"
          spellcheck="false"
          aria-label="Search settings"
          placeholder="Search settings"
          @input=${filterSettingsNavigation}
        />
        <button
          type="button"
          class="settings-sidebar__search-clear"
          aria-label="Clear settings search"
          hidden
          @click=${clearSettingsSearch}
        >${icons.close}</button>
      </div>
      <nav class="settings-sidebar__nav settings-nav__list" aria-label="Settings pages">
        ${SETTINGS_GROUPS.map((group) => html`
          <section class="settings-sidebar__group" data-settings-group=${group}>
            ${group ? html`<h2 class="settings-sidebar__group-label">${group}</h2>` : nothing}
            ${SETTINGS_PAGES.filter((page) => page.group === group).map(
              (page) => html`
                <a
                  class="settings-sidebar__item settings-nav__item ${page.id === props.page ? "settings-sidebar__item--active" : ""}"
                  href="#"
                  data-settings-search=${`${page.label} ${page.group}`.toLocaleLowerCase()}
                  aria-current=${page.id === props.page ? "page" : "false"}
                  @click=${(event: Event) => {
                    event.preventDefault();
                    closeSettingsDrawer(event, false, true);
                    props.onSelectPage(page.id);
                  }}
                  ><span class="settings-sidebar__item-icon" aria-hidden="true">${icons[page.icon]}</span>
                  <span class="settings-sidebar__item-label">${page.label}</span></a
                >
              `,
            )}
          </section>
        `)}
        <p class="settings-sidebar__empty" hidden>No settings match.</p>
      </nav>
      <footer class="settings-sidebar__footer">
        <span class="settings-save-indicator ${props.saveFailed ? "settings-save-indicator--danger settings-status--danger" : ""}" role="status">
          <span class="settings-status__dot" data-status=${props.saveFailed ? "error" : "idle"}></span>
          ${props.saveFailed ? "Settings not saved" : "Settings saved locally"}
        </span>
        <span class="sidebar-footer-build">HUI</span>
      </footer>
      </div>
    </aside>
    <main class="content settings-main" @keydown=${(event: KeyboardEvent) => handleSettingsEscape(event, props)}>
      <header class="content-header content-header--settings">
        <div>
          <div class="page-title" tabindex="-1">${SETTINGS_PAGES.find((page) => page.id === props.page)?.label}</div>
          <div class="page-subtitle">HUI and PI preferences for this workspace.</div>
        </div>
      </header>
      <div class="settings-workspace"><div class="settings-workspace__body">
        <div class="settings-page ${["plugins", "skills", "automation", "worktrees", "workers"].includes(props.page) ? "settings-page--wide" : ""}">
          ${props.page === "appearance"
            ? renderAppearancePage(props)
            : props.page === "skills"
              ? renderSkillsPage(props)
              : props.page === "tools"
                ? renderToolsPage(props)
                : props.page === "models"
                  ? renderModelsPage(props)
                  : props.page === "connection"
                    ? renderConnectionPage(props)
                    : props.page === "integrations"
                    ? renderIntegrationsPage()
                    : props.page === "workers"
                    ? html`<hui-workers-settings></hui-workers-settings>`
                    : props.page === "plugins"
                      ? renderPluginsPage(props)
                      : props.page === "memory"
                        ? renderMemoryPage(props)
                        : props.page === "automation"
                          ? renderAutomationPage(props, renderSection)
                          : props.page === "diagnostics"
                            ? renderDiagnosticsPage(props)
                            : props.page === "security"
                                ? renderSecurityPage(props)
                              : props.page === "worktrees"
                                ? renderWorktreesSettingsPage(props)
                          : renderPendingSettingsPage(props.page)}
        </div>
      </div>
      </div>
    </main>
  `;
}

function filterSettingsNavigation(event: Event) {
  const input = event.currentTarget;
  if (!(input instanceof HTMLInputElement)) {
    return;
  }
  const nav = input.closest(".settings-sidebar")?.querySelector(".settings-sidebar__nav");
  if (!(nav instanceof HTMLElement)) {
    return;
  }
  const query = input.value.trim().toLocaleLowerCase();
  const clear = input.parentElement?.querySelector<HTMLButtonElement>(".settings-sidebar__search-clear");
  if (clear) clear.hidden = query === "";
  let visible = 0;
  for (const link of nav.querySelectorAll<HTMLElement>("[data-settings-search]")) {
    link.hidden = query !== "" && !link.dataset.settingsSearch?.includes(query);
    if (!link.hidden) visible += 1;
  }
  for (const group of nav.querySelectorAll<HTMLElement>("[data-settings-group]")) {
    group.hidden = !group.querySelector("[data-settings-search]:not([hidden])");
  }
  const empty = nav.querySelector<HTMLElement>(".settings-sidebar__empty");
  if (empty) empty.hidden = visible !== 0;
}

function clearSettingsSearch(event: Event) {
  const target = event.currentTarget;
  if (!(target instanceof HTMLElement)) return;
  const input = target.parentElement?.querySelector<HTMLInputElement>(".settings-sidebar__search-input");
  if (!input) return;
  input.value = "";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.focus();
}

function handleSettingsEscape(event: KeyboardEvent, props: SettingsProps) {
  if (event.key !== "Escape" || event.defaultPrevented || hasOpenWebAwesomePopup(event)) {
    return;
  }
  const target = event.target;
  if (target instanceof HTMLInputElement && target.value) {
    event.preventDefault();
    target.value = "";
    target.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }
  event.preventDefault();
  const sidebar = event.currentTarget;
  if (sidebar instanceof HTMLElement && matchMedia(APP_SHELL_DRAWER_MEDIA).matches && sidebar.dataset.open === "true") {
    setSettingsDrawer(sidebar, false, true);
    return;
  }
  props.onClose();
}

function toggleSettingsDrawer(event: Event) {
  const target = event.currentTarget;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  const sidebar = target.closest<HTMLElement>(".settings-sidebar");
  if (sidebar) {
    setSettingsDrawer(sidebar, sidebar.dataset.open !== "true", false);
  }
}

function closeSettingsDrawer(event: Event, returnFocus = false, focusPage = false) {
  const target = event.currentTarget;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  const sidebar = target.closest<HTMLElement>(".settings-sidebar");
  if (!sidebar) {
    return;
  }
  // A page selection must also clear a drawer that was opened before a resize.
  if (!matchMedia(APP_SHELL_DRAWER_MEDIA).matches && !focusPage) {
    return;
  }
  setSettingsDrawer(sidebar, false, returnFocus);
  if (focusPage) {
    queueMicrotask(() => sidebar.parentElement?.querySelector<HTMLElement>(".page-title")?.focus());
  }
}

export function setSettingsDrawer(
  sidebar: HTMLElement,
  open: boolean,
  returnFocus: boolean,
  media?: DrawerMediaQuery,
) {
  const reconciledOpen = open && bindDrawerToNarrowMedia(
    sidebar,
    () => setSettingsDrawer(sidebar, false, false),
    media,
  );
  if (!reconciledOpen) {
    unbindDrawerMedia(sidebar);
  }
  sidebar.dataset.open = String(reconciledOpen);
  const main = sidebar.parentElement?.querySelector<HTMLElement>(".settings-main");
  main?.toggleAttribute("inert", reconciledOpen);
  sidebar.closest?.(".hui-application")?.querySelector(".hui-update-notice")?.toggleAttribute("inert", reconciledOpen);
  const trigger = sidebar.querySelector<HTMLButtonElement>(".settings-mobile-topbar");
  trigger?.setAttribute("aria-expanded", String(reconciledOpen));
  trigger?.setAttribute("aria-label", reconciledOpen ? "Close settings navigation" : "Open settings navigation");
  if (reconciledOpen) {
    sidebar.querySelector<HTMLInputElement>(".settings-sidebar__search-input")?.focus();
  }
  if (!reconciledOpen && returnFocus) {
    trigger?.focus();
  }
}

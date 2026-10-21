/**
 * Settings → Models → Calls (HUI-18): calls with bots run on GPT-Live; this sets its default voice and says which
 * ChatGPT login calls use. The page passes the setting in and saves it; the login status comes from `/__hui/calls` and
 * never carries a token.
 */
import { LitElement, html, nothing } from "lit";
import { GPT_LIVE_VOICES, gptLiveVoiceLabel } from "../../lib/voice/calls.ts";
import type { CallsStatus } from "../../api/schema/calls.ts";
import type { GptLiveVoice } from "../../api/schema/bots.ts";
import type { Settings } from "../../lib/settings/settings.ts";
import { loadCallsStatus } from "../../api/calls.ts";
import { renderSettingsPicker } from "../../views/settings-picker.ts";

/** "Signed in as Account 2 (dani@example.com)", or why calls cannot use ChatGPT now. */
export function chatGptLoginSummary(status: CallsStatus["chatgpt"] | undefined, now = Date.now()): string {
  if (!status) return "Checking the ChatGPT login…";
  if (status.account) return `Calls use ${status.account.name}${status.account.email ? ` (${status.account.email})` : ""}, the first ChatGPT account not waiting for its quota.`;
  if (status.signedIn && status.waitingUntil && status.waitingUntil > now) return `Every ChatGPT account is waiting for its quota until ${new Date(status.waitingUntil).toLocaleString()}.`;
  return "No ChatGPT login yet. Sign in under Providers above: OpenAI Codex, with your ChatGPT Plus or Pro account.";
}

export class HuiCallSettings extends LitElement {
  #calls: Settings["calls"] = { voice: "cove" };
  #status: CallsStatus | undefined;
  #error = "";
  #request = 0;
  onChange: ((next: Settings["calls"]) => void) | undefined;

  get calls(): Settings["calls"] { return this.#calls; }
  set calls(value: Settings["calls"]) {
    this.#calls = value;
    this.requestUpdate();
  }

  override createRenderRoot() { return this; }
  override connectedCallback() {
    super.connectedCallback();
    // A sign-in or sign-out in Providers changes which account calls use.
    window.addEventListener("providers-changed", this.#refresh);
    void this.#load();
  }
  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("providers-changed", this.#refresh);
    this.#request++;
  }

  readonly #refresh = () => { void this.#load(); };

  async #load() {
    const request = ++this.#request;
    try {
      const status = await loadCallsStatus();
      if (request !== this.#request) return;
      this.#status = status;
      this.#error = "";
    } catch (error) {
      if (request === this.#request) this.#error = error instanceof Error ? error.message : "The ChatGPT login could not be read.";
    }
    this.requestUpdate();
  }

  #set(next: Partial<Settings["calls"]>) {
    this.onChange?.({ ...this.#calls, ...next });
  }

  override render() {
    const calls = this.#calls;
    const chatgpt = this.#status?.chatgpt;
    const options = GPT_LIVE_VOICES.map((voice) => ({ value: voice, label: `${gptLiveVoiceLabel(voice)}${voice === "cove" ? " (GPT-Live's default)" : ""}` }));
    return html`<section class="settings-section hui-call-settings">
      <div class="settings-section__header"><div class="settings-section__copy">
        <h2 class="settings-section__heading">Calls</h2>
        <p class="settings-section__desc">Calls with bots talk in real time through GPT-Live, made for phone calls and quick to respond, over your ChatGPT subscription. The bot's utility model answers its quick questions and real work goes to the bot's chat. GPT-Live's audio goes to OpenAI under your ChatGPT account; each call ends as one card in the bot's chat.</p>
      </div></div>
      <div class="settings-group">
        <div class="settings-row">
          <div class="settings-row__text"><span class="settings-row__title">Default GPT-Live voice</span>
            <span class="settings-row__desc">For bots without a call voice of their own (set one on a bot's Settings page).</span></div>
          <div class="settings-row__control">${renderSettingsPicker("Default GPT-Live voice", calls.voice, options, (value) => this.#set({ voice: value as GptLiveVoice }))}</div>
        </div>
        <div class="settings-row">
          <div class="settings-row__text"><span class="settings-row__title">ChatGPT login</span>
            <span class="settings-row__desc hui-call-settings__login" data-ready=${String(Boolean(chatgpt?.account))} role=${this.#error ? "alert" : nothing}>${this.#error || chatGptLoginSummary(chatgpt)}</span></div>
          <div class="settings-row__control"><button type="button" class="btn btn--sm" @click=${this.#refresh}>Check again</button></div>
        </div>
      </div>
    </section>`;
  }
}

if (typeof customElements !== "undefined" && !customElements.get("hui-call-settings")) customElements.define("hui-call-settings", HuiCallSettings);

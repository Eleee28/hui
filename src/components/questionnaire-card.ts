/**
 * HUI's `ask_user_question` card: up to four questions in one card above the
 * composer, one at a time, each with its options (radios, or checkboxes for
 * multi-select), a free-text row and, when options carry one, a Markdown
 * preview of the focused option beside them. It keeps the operator's picks
 * while they move between questions and sends them all at once.
 */
import { html, nothing } from "lit";
import { live } from "lit/directives/live.js";
import { HuiElement } from "../lit/hui-element.ts";
import { renderMarkdown } from "../lib/markdown/markdown.ts";
import type { QuestionResponse, RuntimeQuestion } from "../api/sessions.ts";
import type { QuestionnaireQuestion } from "../api/schema/sessions.ts";

type Draft = { selected: string[]; custom: string; customChosen: boolean };

const emptyDraft = (): Draft => ({ selected: [], custom: "", customChosen: false });

/** The answer a draft gives: chosen labels, and the typed text when it counts. */
function draftReply(draft: Draft): { selected: string[]; custom?: string } {
  const custom = draft.customChosen ? draft.custom.trim() : "";
  return { selected: [...draft.selected], ...(custom ? { custom } : {}) };
}

const answered = (draft: Draft) => draft.selected.length > 0 || (draft.customChosen && draft.custom.trim() !== "");

/** No decorators: the chat view (and so this module) also loads in Node tests. */
export class QuestionnaireCard extends HuiElement {
  static override properties = {
    prompt: { attribute: false },
    onAnswer: { attribute: false },
    idPrefix: {},
    step: { state: true },
    drafts: { state: true },
    previewed: { state: true },
  };
  declare prompt: RuntimeQuestion;
  declare onAnswer: (answer: QuestionResponse) => void;
  /** Unique within the page: two panes can show a card each. */
  declare idPrefix: string;
  declare private step: number;
  declare private drafts: Draft[];
  /** The option whose preview shows, per question. */
  declare private previewed: number[];
  #promptId = "";

  constructor() {
    super();
    this.onAnswer = () => {};
    this.idPrefix = "questionnaire";
    this.step = 0;
    this.drafts = [];
    this.previewed = [];
  }

  private get questions(): readonly QuestionnaireQuestion[] {
    return this.prompt.questions ?? [];
  }

  protected override willUpdate(): void {
    // A snapshot re-sends the same card; only a new one starts over.
    if (this.prompt.id === this.#promptId) return;
    this.#promptId = this.prompt.id;
    this.step = 0;
    this.drafts = this.questions.map(emptyDraft);
    this.previewed = this.questions.map((question) => Math.max(0, question.options.findIndex((option) => option.preview)));
  }

  /** The control the card focuses when it opens or changes question. */
  focusCurrent(): void {
    const target = this.querySelector<HTMLElement>('.questionnaire-card__options [tabindex="0"]');
    target?.focus();
  }

  #update(index: number, change: (draft: Draft) => Draft): void {
    this.drafts = this.drafts.map((draft, each) => each === index ? change(draft) : draft);
  }

  #pick(label: string): void {
    const question = this.questions[this.step]!;
    this.#update(this.step, (draft) => question.multiSelect
      ? { ...draft, selected: draft.selected.includes(label) ? draft.selected.filter((each) => each !== label) : [...draft.selected, label] }
      : { ...draft, selected: [label], customChosen: false });
  }

  #go(step: number): void {
    if (step < 0 || step >= this.questions.length) return;
    this.step = step;
    void this.updateComplete.then(() => this.focusCurrent());
  }

  /** Next question, or Submit on the last one. */
  #advance(): void {
    if (this.step < this.questions.length - 1) this.#go(this.step + 1);
    else this.#submit();
  }

  #submit(): void {
    if (!this.drafts.some(answered)) return;
    this.onAnswer({ answers: this.drafts.map(draftReply) });
  }

  #keydown(event: KeyboardEvent): void {
    // An input method's Enter and Escape belong to its composition.
    if (event.isComposing) return;
    const target = event.target as HTMLElement;
    const typing = target instanceof HTMLInputElement;
    if (event.key === "Escape") {
      // Consumed either way, or the page's Escape would stop the run. Typed text is
      // worth more than a keystroke: the first Escape only leaves the field, for the options.
      event.preventDefault();
      if (typing && (target as HTMLInputElement).value.trim()) this.focusCurrent();
      else this.onAnswer({ cancelled: true });
      return;
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      this.#advance();
      return;
    }
    if (event.altKey || event.metaKey || event.ctrlKey) return;
    const question = this.questions[this.step]!;
    const rows = [...this.querySelectorAll<HTMLElement>(".questionnaire-card__options [data-row]")];
    const current = rows.indexOf(target.closest<HTMLElement>("[data-row]")!);
    // ↑/↓ leave the one-line field too; every other key types in it.
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = rows[(current + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length];
      this.#focusRow(next);
      return;
    }
    if (typing) return;
    if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && this.questions.length > 1) {
      event.preventDefault();
      this.#go(this.step + (event.key === "ArrowRight" ? 1 : -1));
      return;
    }
    const number = Number(event.key);
    if (Number.isInteger(number) && number >= 1 && number <= rows.length) {
      event.preventDefault();
      const row = rows[number - 1]!;
      if (number <= question.options.length) this.#pick(question.options[number - 1]!.label);
      this.#focusRow(row);
      return;
    }
    // Enter on an option moves on, choosing a single-select one first; Space toggles a checkbox, as a click does.
    if (event.key === "Enter" && target.dataset["option"] !== undefined) {
      event.preventDefault();
      if (!question.multiSelect) this.#pick(target.dataset["option"]);
      this.#advance();
    }
  }

  #focusRow(row: HTMLElement | undefined): void {
    if (!row) return;
    const field = row.querySelector("input");
    (field ?? row).focus();
  }

  protected override render() {
    const questions = this.questions;
    const question = questions[this.step];
    if (!question) return nothing;
    const draft = this.drafts[this.step] ?? emptyDraft();
    const multi = question.multiSelect;
    const titleId = `${this.idPrefix}-title`;
    const last = this.step === questions.length - 1;
    const preview = question.options[this.previewed[this.step] ?? 0]?.preview;
    const focusIndex = Math.max(0, question.options.findIndex((option) => draft.selected.includes(option.label)));
    const customOn = draft.customChosen && draft.custom.trim() !== "";
    const showPreview = (index: number) => {
      if (!question.options[index]?.preview || this.previewed[this.step] === index) return;
      this.previewed = this.previewed.map((each, step) => step === this.step ? index : each);
    };
    return html`<form class="session-question-card chat-question-panel questionnaire-card" aria-labelledby=${titleId}
      @submit=${(event: SubmitEvent) => { event.preventDefault(); this.#advance(); }}
      @keydown=${(event: KeyboardEvent) => this.#keydown(event)}>
      <header class="chat-question-panel__topline">
        <strong class="chat-question-panel__title">${questions.length > 1 ? "Questions" : question.header}</strong>
        <span class="chat-question-panel__progress" aria-label=${`Question ${this.step + 1} of ${questions.length}`}>${this.step + 1}/${questions.length}</span>
      </header>
      ${questions.length > 1 ? html`<div class="questionnaire-card__tabs" role="tablist" aria-label="Questions">
        ${questions.map((each, index) => html`<button type="button" role="tab" class="questionnaire-card__tab" tabindex=${index === this.step ? "0" : "-1"}
          aria-selected=${String(index === this.step)} @click=${() => this.#go(index)}>
          <span class="questionnaire-card__tab-check" aria-hidden="true">${answered(this.drafts[index] ?? emptyDraft()) ? "✓" : ""}</span>${each.header}
          ${answered(this.drafts[index] ?? emptyDraft()) ? html`<span class="sr-only">(answered)</span>` : nothing}
        </button>`)}
      </div>` : nothing}
      <div class="chat-question-panel__heading">
        <span id=${titleId} class="chat-question-panel__prompt">${question.question}</span>
      </div>
      ${multi ? html`<div class="questionnaire-card__hint">Choose all that apply.</div>` : nothing}
      <div class="questionnaire-card__body ${preview ? "questionnaire-card__body--preview" : ""}">
        <div class="chat-question-panel__options questionnaire-card__options" role=${multi ? "group" : "radiogroup"} aria-labelledby=${titleId}>
          ${question.options.map((option, index) => {
            const selected = draft.selected.includes(option.label);
            return html`<button type="button" data-row data-option=${option.label}
              class="chat-question-panel__option ${selected ? "chat-question-panel__option--selected" : ""}"
              role=${multi ? "checkbox" : "radio"} aria-checked=${String(selected)} tabindex=${index === focusIndex ? "0" : "-1"}
              @click=${() => this.#pick(option.label)}
              @focus=${() => showPreview(index)} @mouseenter=${() => showPreview(index)}>
              <span class="chat-question-panel__option-marker" aria-hidden="true">${selected ? "✓" : ""}</span>
              <span class="chat-question-panel__option-copy"><strong>${option.label}</strong>${option.description ? html`<small>${option.description}</small>` : nothing}</span>
              <kbd>${index + 1}</kbd>
            </button>`;
          })}
          <label data-row class="chat-question-panel__option chat-question-panel__option--other ${customOn ? "chat-question-panel__option--selected" : ""}">
            <span class="chat-question-panel__option-marker" aria-hidden="true">${customOn ? "✓" : ""}</span>
            <input type="text" class="chat-question-panel__other" maxlength="4000" placeholder="Type something…" aria-label="Your own answer"
              .value=${live(draft.custom)}
              @input=${(event: Event) => {
                const value = (event.currentTarget as HTMLInputElement).value;
                this.#update(this.step, (each) => ({ ...each, custom: value, customChosen: value.trim() !== "", ...(multi || !value.trim() ? {} : { selected: [] }) }));
              }} />
            <kbd>${question.options.length + 1}</kbd>
          </label>
        </div>
        ${preview ? html`<div class="questionnaire-card__preview" aria-label="Preview" role="region"><div class="chat-text">${renderMarkdown(preview)}</div></div>` : nothing}
      </div>
      <footer class="chat-question-panel__footer">
        <button type="button" class="btn btn--sm chat-question-panel__skip" @click=${() => this.onAnswer({ cancelled: true })}>Cancel</button>
        ${this.step > 0 ? html`<button type="button" class="btn btn--sm chat-question-panel__back" @click=${() => this.#go(this.step - 1)}>Back</button>` : nothing}
        <button type="submit" class="btn btn--sm primary" ?disabled=${last && !this.drafts.some(answered)}>${last ? "Submit" : "Next"}</button>
      </footer>
    </form>`;
  }
}

if (typeof customElements !== "undefined" && !customElements.get("hui-questionnaire-card")) customElements.define("hui-questionnaire-card", QuestionnaireCard);

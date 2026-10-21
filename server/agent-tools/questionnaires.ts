/**
 * Structured questions an agent puts to the operator with the
 * `ask_user_question` tool: HUI's own replacement for a PI extension's
 * sequence of plain select and input dialogs. The whole questionnaire is one
 * pending card in the session's question list, answered from the browser in
 * one go. Like secret requests it lives in gateway memory: a restart drops it,
 * and the tool call ends as interrupted. With a question timeout set (Settings
 * → Tools → Questions) a card nobody answers in time ends as timed out, and the
 * agent goes on without an answer.
 */
import { randomUUID } from "node:crypto";
import type { QuestionnaireAnswer, QuestionnaireOption, QuestionnaireQuestion, QuestionnaireResult } from "../api/sessions.ts";

const MAX_QUESTIONS = 4;
const MAX_HEADER = 16;
const MAX_LABEL = 60;
const MAX_TEXT = 500;
/** Four full questions stay under the PI child bridge's 64 KiB request limit. */
const MAX_PREVIEW = 2_500;
/** Option labels the card adds itself or that models reach for instead of the free-text row. */
const RESERVED_LABELS: ReadonlySet<string> = new Set(["Other", "Type something.", "Next"]);
/** Longest typed answer the card sends for one question. */
const MAX_CUSTOM = 4_000;
/** The transports' ceiling on one call: a day, after which the caller gives up and the card goes. */
export const QUESTIONNAIRE_WAIT_MS = 24 * 60 * 60_000;

/** A pending questionnaire as the session's question list carries it; `title` is the first question. */
export type QuestionnairePrompt = { id: string; method: "questionnaire"; title: string; questions: QuestionnaireQuestion[] };

type Pending = { sessionId: string; prompt: QuestionnairePrompt; settle(result: QuestionnaireResult): void };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function text(value: unknown, name: string, maximum: number, required = true): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (required && !trimmed) throw new Error(`${name} must be non-empty text.`);
  if (trimmed.length > maximum) throw new Error(`${name} must be at most ${maximum} characters.`);
  return trimmed;
}

/** The model's call, checked: errors are written for the model, which retries with a fixed call. */
export function parseQuestionnaire(params: Record<string, unknown>): QuestionnaireQuestion[] {
  const raw = params["questions"];
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("questions must hold at least one question.");
  if (raw.length > MAX_QUESTIONS) throw new Error(`Ask at most ${MAX_QUESTIONS} questions per call.`);
  const questions = raw.map((entry, index): QuestionnaireQuestion => {
    const at = `questions[${index}]`;
    if (!isRecord(entry)) throw new Error(`${at} must be an object.`);
    const options = entry["options"];
    if (!Array.isArray(options) || options.length < 2 || options.length > 4) throw new Error(`${at}.options must hold 2-4 options.`);
    const parsed = options.map((option, each): QuestionnaireOption => {
      const where = `${at}.options[${each}]`;
      if (!isRecord(option)) throw new Error(`${where} must be an object.`);
      const label = text(option["label"], `${where}.label`, MAX_LABEL);
      if (RESERVED_LABELS.has(label)) throw new Error(`${where}.label "${label}" is reserved: the card already offers a free-text answer.`);
      const preview = text(option["preview"], `${where}.preview`, MAX_PREVIEW, false);
      return { label, description: text(option["description"], `${where}.description`, MAX_TEXT, false), ...(preview ? { preview } : {}) };
    });
    if (new Set(parsed.map(({ label }) => label)).size !== parsed.length) throw new Error(`${at}.options must have unique labels.`);
    const multiSelect = entry["multiSelect"] === true;
    if (multiSelect && parsed.some((option) => option.preview)) throw new Error(`${at}: previews are for single-select questions only.`);
    return { header: text(entry["header"], `${at}.header`, MAX_HEADER), question: text(entry["question"], `${at}.question`, MAX_TEXT), multiSelect, options: parsed };
  });
  if (new Set(questions.map(({ question }) => question)).size !== questions.length) throw new Error("Each question must be asked once.");
  return questions;
}

/** The card's answers, index-aligned with the questions; a question left blank is left out. */
function parseAnswers(questions: readonly QuestionnaireQuestion[], body: Record<string, unknown>): QuestionnaireAnswer[] {
  const raw = body["answers"];
  if (!Array.isArray(raw) || raw.length !== questions.length) throw new Error("Answer each question, or cancel.");
  return questions.flatMap((question, index): QuestionnaireAnswer[] => {
    const entry: unknown = raw[index];
    if (!isRecord(entry)) throw new Error("Answer each question, or cancel.");
    const chosen = Array.isArray(entry["selected"]) ? entry["selected"] : [];
    const labels = question.options.map(({ label }) => label);
    if (!chosen.every((label): label is string => typeof label === "string" && labels.includes(label))) throw new Error(`"${question.header}" has no such option.`);
    // In the questions' order, once each.
    const selected = labels.filter((label) => chosen.includes(label));
    const custom = text(entry["custom"], "Your answer", MAX_CUSTOM, false);
    if (custom) selected.push(custom);
    if (!question.multiSelect && selected.length > 1) throw new Error(`"${question.header}" takes one answer.`);
    if (!selected.length) return [];
    const preview = question.options.find(({ label }) => label === selected[0] && !custom)?.preview;
    return [{ header: question.header, question: question.question, selected, ...(preview ? { preview } : {}) }];
  });
}

export class Questionnaires {
  #pending = new Map<string, Pending>();
  #onChange: (sessionId: string) => void;

  constructor(options: { onChange?: (sessionId: string) => void } = {}) {
    this.#onChange = options.onChange ?? (() => {});
  }

  questions(sessionId: string): QuestionnairePrompt[] {
    return [...this.#pending.values()].filter((pending) => pending.sessionId === sessionId).map(({ prompt }) => prompt);
  }

  /** The tool call: waits until the operator answers or cancels, `signal`
   * aborts (Stop, the caller went away or its transport gave up), or
   * `timeoutMinutes` pass without an answer (0 waits without a limit). */
  async request(sessionId: string, params: Record<string, unknown>, signal?: AbortSignal, timeoutMinutes = 0): Promise<QuestionnaireResult> {
    const questions = parseQuestionnaire(params);
    if (signal?.aborted) return { cancelled: true, answers: [] };
    const id = randomUUID();
    return new Promise<QuestionnaireResult>((resolve) => {
      const settle = (result: QuestionnaireResult) => {
        if (!this.#pending.delete(id)) return;
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        this.#onChange(sessionId);
        resolve(result);
      };
      const cancel = () => settle({ cancelled: true, answers: [] });
      const timer = timeoutMinutes > 0
        ? setTimeout(() => settle({ cancelled: true, answers: [], timedOut: true, timeoutMinutes }), timeoutMinutes * 60_000)
        : undefined;
      timer?.unref();
      signal?.addEventListener("abort", cancel, { once: true });
      this.#pending.set(id, { sessionId, prompt: { id, method: "questionnaire", title: questions[0]!.question, questions }, settle });
      this.#onChange(sessionId);
    });
  }

  /** Settles one of the session's questionnaires from the question route.
   * False when `id` is none of them, so the route tries the next owner. */
  answer(sessionId: string, id: string, body: Record<string, unknown>): boolean {
    const pending = this.#pending.get(id);
    if (pending?.sessionId !== sessionId) return false;
    if (body["cancelled"] === true) {
      pending.settle({ cancelled: true, answers: [] });
      return true;
    }
    const answers = parseAnswers(pending.prompt.questions, body);
    pending.settle({ cancelled: answers.length === 0, answers });
    return true;
  }

  /** Gateway stop: pending questionnaires end cancelled. */
  dispose(): void {
    for (const { settle } of [...this.#pending.values()]) settle({ cancelled: true, answers: [] });
  }
}

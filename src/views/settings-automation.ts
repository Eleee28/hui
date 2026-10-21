/**
 * Automation settings region. The scheduler, its tasks and its run history are
 * owned by HUI (`server/automation.ts`); PI has no scheduler contract to reuse.
 * Rendering stays free of fetches: every mutation is a prop callback.
 */
import { html, nothing, type TemplateResult } from "lit";
import type {
  AutomationRun,
  AutomationSchedule,
  AutomationSnapshot,
  AutomationTask,
  AutomationTaskInput,
} from "../api/schema/automation.ts";
import type { SessionView } from "../api/sessions.ts";
import { routineCadenceSummary, routineFacts } from "../lib/bots/routines.ts";
import { automationRunLabel, automationRunRecoveryDetail } from "../lib/automation-recovery.ts";
import { icons } from "../lib/icons.ts";
import { labelDropdown, closeDropdownOnEscape } from "../lib/web-awesome.ts";
import { renderSettingsToggle } from "./settings-toggle.ts";

export type AutomationProps = {
  /** `undefined` while loading, so an empty task list is never shown as "none". */
  automation: AutomationSnapshot | undefined;
  automationError: string;
  automationPending: boolean;
  /** Rejected form input, reported next to the create form. */
  automationFormError: string;
  /** A refused task or run action, reported next to the list that owns it. */
  automationActionError: string;
  /** Every registered session. Bot chats label their routines but are not
   * offered as targets: a bot's routines are added from its own panel. */
  sessions: readonly SessionView[];
  onRetryAutomation: () => void;
  /** Resolves `true` once the scheduler accepted the task, so the form clears. */
  onCreateAutomationTask: (input: AutomationTaskInput) => Promise<boolean>;
  automationEditingId: string;
  onEditAutomationTask: (task: AutomationTask) => void;
  onCancelAutomationEdit: () => void;
  onUpdateAutomationTask: (task: AutomationTask, input: AutomationTaskInput) => Promise<boolean>;
  onAutomationFormError: (message: string) => void;
  onSetAutomationEnabled: (task: AutomationTask, enabled: boolean) => void;
  onDeleteAutomationTask: (task: AutomationTask) => void;
  onRunAutomationTask: (task: AutomationTask) => void;
  onCancelAutomationRun: (run: AutomationRun) => void;
};

export type AutomationState = "loading" | "error" | "ready";

export function automationState(
  props: Pick<AutomationProps, "automation" | "automationError">,
): AutomationState {
  if (props.automation) return "ready";
  return props.automationError ? "error" : "loading";
}

/** A run is only cancellable while the scheduler still owns it. */
export function runIsActive(run: AutomationRun): boolean {
  return run.status === "queued" || run.status === "running";
}

export function describeSchedule(schedule: AutomationSchedule): string {
  if (schedule.kind === "at") return `Once at ${formatTimestamp(schedule.at)}`;
  if (schedule.kind === "every") {
    const minutes = Math.round(schedule.everyMs / 60_000);
    if (minutes % 1440 === 0) {
      const days = minutes / 1440;
      return `Every ${days === 1 ? "day" : `${days} days`}`;
    }
    if (minutes % 60 === 0) {
      const hours = minutes / 60;
      return `Every ${hours === 1 ? "hour" : `${hours} hours`}`;
    }
    return `Every ${minutes === 1 ? "minute" : `${minutes} minutes`}`;
  }
  return `Cron ${schedule.expression} (${schedule.timezone})`;
}

/** A bot routine's schedule as its panel wrote it ("Daily at 08:00",
 * "Mondays at 09:30"); anything else as the scheduler's own kinds. */
export function describeRoutineSchedule(schedule: AutomationSchedule): string {
  return routineCadenceSummary(schedule) ?? describeSchedule(schedule);
}

export function formatTimestamp(value: string | null | undefined): string {
  if (!value) return "—";
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return new Date(parsed).toLocaleString();
}

export class AutomationFormError extends Error {}

function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

/** Local browser time, because `datetime-local` carries no offset. */
function localDateTimeToIso(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new AutomationFormError("Run at must be a valid date and time.");
  return new Date(parsed).toISOString();
}

export function scheduleFromForm(form: FormData): AutomationSchedule {
  const kind = field(form, "scheduleKind");
  if (kind === "at") {
    const at = field(form, "at");
    if (!at) throw new AutomationFormError("Choose the date and time to run once.");
    return { kind: "at", at: localDateTimeToIso(at) };
  }
  if (kind === "every") {
    const minutes = Number(field(form, "everyMinutes"));
    if (!Number.isInteger(minutes) || minutes < 1) {
      throw new AutomationFormError("Repeat interval must be a whole number of minutes, at least 1.");
    }
    return { kind: "every", everyMs: minutes * 60_000 };
  }
  if (kind === "cron") {
    const expression = field(form, "cronExpression");
    if (!expression) throw new AutomationFormError("Enter a five-field cron expression.");
    const timezone = field(form, "cronTimezone") || localTimezone();
    return { kind: "cron", expression, timezone };
  }
  throw new AutomationFormError("Choose a schedule kind.");
}

export function taskInputFromForm(form: FormData): AutomationTaskInput {
  const name = field(form, "name");
  if (!name) throw new AutomationFormError("Name the task.");
  const sessionId = field(form, "sessionId");
  if (!sessionId) throw new AutomationFormError("Choose the session the task runs in.");
  const prompt = field(form, "prompt");
  if (!prompt) throw new AutomationFormError("Write the prompt the task sends.");
  const timeoutSeconds = Number(field(form, "timeoutSeconds") || "900");
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 10 || timeoutSeconds > 86_400) {
    throw new AutomationFormError("Timeout must be a whole number between 10 and 86400 seconds.");
  }
  return {
    name,
    description: field(form, "description"),
    sessionId,
    prompt,
    schedule: scheduleFromForm(form),
    timeoutSeconds,
  };
}

export function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function sessionLabel(props: AutomationProps, sessionId: string): string {
  const session = props.sessions.find((item) => item.id === sessionId);
  if (!session) return `${sessionId} (missing)`;
  if (session.bot) return `Bot · ${session.bot.name}`;
  return session.group ? `${session.group} — ${session.title}` : session.title;
}

function renderTask(props: AutomationProps, task: AutomationTask) {
  const lastRun = props.automation?.runs.find((run) => run.taskId === task.id);
  const retryAt = lastRun?.status === "queued" ? lastRun.retryAt : undefined;
  // Bot routines read as their bot's panel shows them; other tasks keep the generic summary.
  const routine = props.sessions.some((session) => session.id === task.sessionId && session.bot);
  // Who made it when a bot did, by its handle now, and a temporary task's limits.
  const facts = routineFacts(task, { handle: (botId) => props.sessions.find((session) => session.bot?.id === botId)?.bot?.handle });
  return html`
    <article class="cron-table__row ${task.enabled ? "" : "cron-table__row--paused"}" data-task=${task.id}>
      <button type="button" class="cron-table__name" @click=${() => props.onEditAutomationTask(task)} aria-label=${`Edit ${task.name}`}>
        <span class="cron-table__state" aria-hidden="true"><span class="cron-table__state-dot"></span></span>
        <span class="cron-table__name-copy"><span class="cron-table__name-line"><span class="cron-table__name-text">${task.name}</span></span>
          <span class="cron-table__name-meta"><span class="cron-table__description">${task.description || sessionLabel(props, task.sessionId)}</span>${facts.map((fact) => html`<span class="cron-table__meta-separator" aria-hidden="true">·</span><span class="cron-table__fact">${fact}</span>`)}</span>
        </span>
      </button>
      <span class="cron-table__cell cron-table__schedule"><span class="cron-table__cell-label">Schedule</span><span class="cron-table__cell-value">${routine ? describeRoutineSchedule(task.schedule) : describeSchedule(task.schedule)}</span></span>
      <span class="cron-table__cell cron-table__next"><span class="cron-table__cell-label">${retryAt ? "Next retry" : "Next run"}</span><span class="cron-table__cell-value" title=${retryAt ? `Next retry ${formatTimestamp(retryAt)}` : nothing}>${formatTimestamp(retryAt ?? task.nextRunAt)}</span></span>
      <span class="cron-table__cell cron-table__last"><span class="cron-table__cell-label">Last run</span><span class="cron-table__cell-value" title=${lastRun ? [automationRunLabel(lastRun), automationRunRecoveryDetail(lastRun, formatTimestamp), lastRun.error].filter(Boolean).join(" · ") : nothing}>${lastRun ? automationRunLabel(lastRun) : "—"}</span></span>
      <span class="cron-table__actions">
        <button type="button" class="btn btn--sm btn--ghost cron-row-run" ?disabled=${props.automationPending} @click=${() => props.onRunAutomationTask(task)} title="Run now" aria-label=${`Run now: ${task.name}`}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="6 3 20 12 6 21 6 3"></polygon></svg>
        </button>
        ${renderSettingsToggle(`Enable ${task.name}`, task.enabled, (checked) => props.onSetAutomationEnabled(task, checked), props.automationPending)}
        <wa-dropdown class="cron-job-menu" placement="bottom-end" @wa-show=${labelDropdown} @keydown=${closeDropdownOnEscape}
          @wa-select=${(event: CustomEvent<{ item: { value: string } }>) => {
            if (props.automationPending) return;
            if (event.detail.item.value === "edit") props.onEditAutomationTask(task);
            if (event.detail.item.value === "delete") props.onDeleteAutomationTask(task);
          }}>
          <button slot="trigger" type="button" class="btn btn--sm btn--ghost cron-job-menu__trigger" aria-label=${`Actions for ${task.name}`}>${icons.moreHorizontal}</button>
          <wa-dropdown-item value="edit" class="cron-job-menu__item" ?disabled=${props.automationPending}>Edit</wa-dropdown-item>
          <wa-dropdown-item value="delete" class="cron-job-menu__item danger" ?disabled=${props.automationPending}>Delete</wa-dropdown-item>
        </wa-dropdown>
      </span>
    </article>
  `;
}

function renderRun(props: AutomationProps, run: AutomationRun) {
  const recovery = automationRunRecoveryDetail(run, formatTimestamp);
  return html`
    <article class="cron-run-entry" data-run=${run.id}>
      <div class="cron-run-entry__header">
        <span class="cron-run-entry__title">${run.taskName}</span>
        <span class="settings-status">${automationRunLabel(run)}</span>
      </div>
      <p class="cron-run-entry__facts">
        ${run.source === "manual" ? "Manual" : "Scheduled"} · started ${formatTimestamp(run.startedAt ?? run.createdAt)}
        ${run.finishedAt ? html` · finished ${formatTimestamp(run.finishedAt)}` : nothing}
      </p>
      ${recovery ? html`<p class="cron-run-entry__body">${recovery}</p>` : nothing}
      ${run.summary ? html`<p class="cron-run-entry__body">${run.summary}</p>` : nothing}
      ${run.error ? html`<p class="cron-run-entry__body" role="alert">${run.error}</p>` : nothing}
      ${runIsActive(run)
        ? html`<div class="automation-actions cron-detail-actions">
            <button
              type="button"
              class="btn"
              ?disabled=${props.automationPending}
              @click=${() => props.onCancelAutomationRun(run)}
            >Cancel</button>
          </div>`
        : nothing}
    </article>
  `;
}

function localDateTimeValue(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "";
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.valueOf() - offset).toISOString().slice(0, 16);
}

function scheduleValue(task: AutomationTask | undefined, kind: AutomationSchedule["kind"]): string {
  if (!task || task.schedule.kind !== kind) return "";
  if (kind === "cron" && task.schedule.kind === "cron") return task.schedule.expression;
  if (kind === "every" && task.schedule.kind === "every") return String(task.schedule.everyMs / 60_000);
  if (kind === "at" && task.schedule.kind === "at") return localDateTimeValue(task.schedule.at);
  return "";
}

function renderTaskForm(props: AutomationProps, renderSection: SectionRenderer) {
  const editing = props.automation?.tasks.find((task) => task.id === props.automationEditingId);
  // Bot chats are not offered as targets, except the one a bot routine being edited already uses.
  const targets = props.sessions.filter((session) => !session.bot || session.id === editing?.sessionId);
  const initialKind = editing?.schedule.kind ?? "cron";
  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    try {
      const input = taskInputFromForm(new FormData(form));
      // Keeps rejected input on screen: only an accepted task clears the form.
      const mutation = editing
        ? props.onUpdateAutomationTask(editing, { ...input, enabled: editing.enabled })
        : props.onCreateAutomationTask(input);
      void mutation.then((created) => {
        if (!created) return;
        if (editing) {
          props.onCancelAutomationEdit();
          return;
        }
        form.reset();
        // Property bindings do not establish HTML default values. Restore the
        // actual defaults explicitly after an accepted create.
        const timezone = form.elements.namedItem("cronTimezone");
        if (timezone instanceof HTMLInputElement) timezone.value = localTimezone();
        const timeout = form.elements.namedItem("timeoutSeconds");
        if (timeout instanceof HTMLInputElement) timeout.value = "900";
        const schedule = form.elements.namedItem("scheduleKind");
        if (schedule && "value" in schedule) schedule.value = "cron";
        form.setAttribute("data-schedule", "cron");
        syncScheduleVisibility(form, "cron");
      });
    } catch (error) {
      props.onAutomationFormError(
        error instanceof AutomationFormError ? error.message : "Could not read the task form.",
      );
    }
  };
  // Keep inactive fields hidden in the DOM as well as in the fallback CSS.
  const selectSchedule = (event: Event) => {
    const select = event.currentTarget as HTMLElement & { value: string };
    const form = select.closest("form");
    form?.setAttribute("data-schedule", select.value);
    if (form) syncScheduleVisibility(form, select.value);
  };
  return renderSection(
    editing ? "Edit task" : "New task",
    targets.length
      ? "The task sends its prompt to an existing session on the schedule you pick."
      : "Start a session first: automation runs inside a session HUI already owns.",
    html`
      <form class="hui-automation-form" id="automation-task-form" data-schedule=${initialKind} novalidate @submit=${submit}>
        <label class="settings-row automation-field"><span class="settings-row__text"><span class="settings-row__title">Name</span></span><span class="settings-row__control"><span class="cron-control">
          <input class="settings-input" name="name" type="text" maxlength="200" placeholder="Nightly review" .value=${editing?.name ?? ""} />
        </span></span></label>
        <label class="settings-row automation-field"><span class="settings-row__text"><span class="settings-row__title">Description</span></span><span class="settings-row__control"><span class="cron-control">
          <input class="settings-input" name="description" type="text" maxlength="500" placeholder="Optional" .value=${editing?.description ?? ""} />
        </span></span></label>
        <label class="settings-row automation-field"><span class="settings-row__text"><span class="settings-row__title">Session</span></span><span class="settings-row__control"><span class="cron-control">
          <wa-select class="settings-select" size="s" placeholder="Choose a session" name="sessionId" ?disabled=${!targets.length} .value=${editing?.sessionId ?? ""}>
            <span slot="label" class="settings-control__sr-label">Session</span>
            ${targets.map(
              (session) => html`<wa-option value=${session.id}>${sessionLabel(props, session.id)}</wa-option>`,
            )}
          </wa-select>
        </span></span></label>
        <label class="settings-row automation-field"><span class="settings-row__text"><span class="settings-row__title">Schedule</span></span><span class="settings-row__control"><span class="cron-control">
          <wa-select class="settings-select" size="s" name="scheduleKind" .value=${initialKind} @change=${selectSchedule}>
            <span slot="label" class="settings-control__sr-label">Schedule</span>
            <wa-option value="cron">Cron expression</wa-option>
            <wa-option value="every">Repeat interval</wa-option>
            <wa-option value="at">Once</wa-option>
          </wa-select>
        </span></span></label>
        <label class="settings-row automation-field automation-field--cron" ?hidden=${initialKind !== "cron"}><span class="settings-row__text"><span class="settings-row__title">Cron expression</span></span><span class="settings-row__control"><span class="cron-control">
          <input class="settings-input" name="cronExpression" type="text" spellcheck="false" placeholder="0 9 * * 1-5" .value=${scheduleValue(editing, "cron")} />
        </span></span></label>
        <label class="settings-row automation-field automation-field--cron" ?hidden=${initialKind !== "cron"}><span class="settings-row__text"><span class="settings-row__title">Cron timezone</span></span><span class="settings-row__control"><span class="cron-control">
          <input class="settings-input" name="cronTimezone" type="text" spellcheck="false" .value=${editing?.schedule.kind === "cron" ? editing.schedule.timezone : localTimezone()} />
        </span></span></label>
        <label class="settings-row automation-field automation-field--every" ?hidden=${initialKind !== "every"}><span class="settings-row__text"><span class="settings-row__title">Repeat every (minutes)</span></span><span class="settings-row__control"><span class="cron-control">
          <input class="settings-input" name="everyMinutes" type="number" min="1" step="1" placeholder="60" .value=${scheduleValue(editing, "every")} />
        </span></span></label>
        <label class="settings-row automation-field automation-field--at" ?hidden=${initialKind !== "at"}><span class="settings-row__text"><span class="settings-row__title">Run once at</span></span><span class="settings-row__control"><span class="cron-control">
          <input class="settings-input" name="at" type="datetime-local" .value=${scheduleValue(editing, "at")} />
        </span></span></label>
        <label class="settings-row settings-row--stacked automation-field"><span class="settings-row__text"><span class="settings-row__title">Prompt</span></span><span class="settings-row__control"><span class="cron-control">
          <textarea class="settings-input" name="prompt" maxlength="20000" placeholder="What should the session do?" .value=${editing?.prompt ?? ""}></textarea>
        </span></span></label>
        <label class="settings-row automation-field"><span class="settings-row__text"><span class="settings-row__title">Timeout (seconds)</span></span><span class="settings-row__control"><span class="cron-control">
          <input class="settings-input" name="timeoutSeconds" type="number" min="10" max="86400" step="1" .value=${String(editing?.timeoutSeconds ?? 900)} />
        </span></span></label>
        <div class="automation-actions cron-editor-actions">
          <button type="submit" class="btn" ?disabled=${props.automationPending || !targets.length}>${editing ? "Update task" : "Create task"}</button>
          ${editing ? html`<button type="button" class="btn" ?disabled=${props.automationPending} @click=${props.onCancelAutomationEdit}>Cancel edit</button>` : nothing}
        </div>
        ${props.automationFormError
          ? html`<p class="settings-page__note settings-page__intro" role="alert">${props.automationFormError}</p>`
          : nothing}
      </form>
    `,
  );
}

type SectionRenderer = (heading: string, description: string, body: TemplateResult) => TemplateResult;

function syncScheduleVisibility(form: HTMLFormElement, kind: string) {
  for (const schedule of ["cron", "every", "at"]) {
    for (const field of form.querySelectorAll<HTMLElement>(`.automation-field--${schedule}`)) {
      field.hidden = schedule !== kind;
    }
  }
}

export function renderAutomationPage(props: AutomationProps, renderSection: SectionRenderer) {
  const state = automationState(props);
  if (state !== "ready") {
    return html`
      <p class="settings-page__intro">Scheduled tasks, manual runs and run history owned by HUI.</p>
      <div class="settings-page__note settings-page__intro" role=${state === "error" ? "alert" : "status"}>
        ${state === "error" ? props.automationError : "Reading automation state…"}
        ${state === "error"
          ? html`<button type="button" class="btn" @click=${props.onRetryAutomation}>Retry</button>`
          : nothing}
      </div>
    `;
  }
  const snapshot = props.automation as AutomationSnapshot;
  const { tasks, runs, scheduler: { nextWakeAt } } = snapshot;
  return html`<div class="cron-page settings-stack">
    <p class="settings-page__intro">Scheduled tasks, manual runs and run history owned by HUI.</p>
    ${renderSection(
      "Scheduler",
      snapshot.scheduler.activeRuns
        ? `${snapshot.scheduler.activeRuns} run${snapshot.scheduler.activeRuns === 1 ? "" : "s"} in flight`
        : "Idle.",
      html`
        <div class="settings-row">
          <div class="settings-row__text">
            <span class="settings-row__title">Next wake</span>
            <span class="settings-row__desc">When the scheduler next checks for due tasks.</span>
          </div>
          <div class="settings-row__control">
            <span class="settings-row__muted">${formatTimestamp(nextWakeAt)}</span>
          </div>
        </div>
      `,
    )}
    ${props.automationActionError
      ? html`<p class="settings-page__note settings-page__intro automation-action-error" role="alert" data-automation-action-error>
          ${props.automationActionError}
        </p>`
      : nothing}
    ${renderSection(
      "Tasks",
      tasks.length ? `${tasks.length} task${tasks.length === 1 ? "" : "s"} configured` : "No tasks configured.",
      tasks.length
        ? html`<div class="cron-table"><div class="cron-table__head"><span>Task</span><span>Schedule</span><span>Next run</span><span>Last run</span><span></span></div>${tasks.map((task) => renderTask(props, task))}</div>`
        : html`<div class="settings-row">
            <div class="settings-row__text">
              <span class="settings-row__title">Nothing scheduled</span>
              <span class="settings-row__desc">Create a task below to run a prompt on a schedule.</span>
            </div>
            <div class="settings-row__control"><span class="settings-row__muted">—</span></div>
          </div>`,
    )}
    ${renderTaskForm(props, renderSection)}
    ${renderSection(
      "Run history",
      runs.length ? `${runs.length} recorded run${runs.length === 1 ? "" : "s"}` : "No runs recorded yet.",
      runs.length
        ? html`<div class="cron-runs cron-history"><div class="cron-runs__list">${runs.map((run) => renderRun(props, run))}</div></div>`
        : html`<div class="settings-row">
            <div class="settings-row__text">
              <span class="settings-row__title">No runs</span>
              <span class="settings-row__desc">Manual and scheduled runs appear here with their outcome.</span>
            </div>
            <div class="settings-row__control"><span class="settings-row__muted">—</span></div>
          </div>`,
    )}
    ${props.automationError
      ? html`<div class="settings-page__note settings-page__intro" role="alert">Refresh failed: ${props.automationError}</div>`
      : nothing}
  </div>`;
}

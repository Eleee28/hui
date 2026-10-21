/**
 * `AutomationController` keeps the scheduler's state outside `hui-app.ts`: the last snapshot, the read, form and action
 * errors, the task being edited, and the poll that re-reads the snapshot while an automation page shows (run status
 * settles in the scheduler, not in the browser). Every change goes through `api/automation.ts` and adopts the snapshot
 * the server answers with.
 */
import type { ReactiveController, ReactiveControllerHost } from "lit";
import * as automationApi from "../api/automation.ts";
import type { AutomationRun, AutomationSnapshot, AutomationTask, AutomationTaskInput } from "../api/automation.ts";
import type { AutomationProps } from "../views/settings-automation.ts";

/** Matches the scheduler's own cadence closely enough to show settling runs. */
export const AUTOMATION_POLL_MS = 3000;

export type AutomationApi = Pick<
  typeof automationApi,
  "loadAutomation" | "createAutomationTask" | "updateAutomationTask" | "deleteAutomationTask" | "runAutomationTask" | "cancelAutomationRun"
>;

export class AutomationController implements ReactiveController {
  snapshot: AutomationSnapshot | undefined;
  error = "";
  pending = false;
  formError = "";
  actionError = "";
  editingId = "";
  readonly #host: ReactiveControllerHost & { renderRoot: ParentNode };
  readonly #api: AutomationApi;
  #poll: ReturnType<typeof setInterval> | undefined;
  #loadRequest = 0;
  #loadsInFlight = 0;

  constructor(host: ReactiveControllerHost & { renderRoot: ParentNode }, api: AutomationApi = automationApi) {
    this.#host = host;
    this.#api = api;
    host.addController(this);
  }

  hostDisconnected(): void {
    this.stopPolling();
  }

  #set(next: Partial<Pick<AutomationController, "snapshot" | "error" | "pending" | "formError" | "actionError" | "editingId">>): void {
    Object.assign(this, next);
    this.#host.requestUpdate();
  }

  load = () => {
    const request = ++this.#loadRequest;
    this.#loadsInFlight += 1;
    this.#set({ error: "" });
    void this.#api.loadAutomation()
      .then((snapshot) => {
        if (request === this.#loadRequest) this.#set({ snapshot });
      })
      .catch((error: unknown) => {
        if (request === this.#loadRequest) this.#set({ error: error instanceof Error ? error.message : "Could not read automation state." });
      })
      .finally(() => {
        this.#loadsInFlight -= 1;
      });
  };

  startPolling(): void {
    if (this.#poll !== undefined) return;
    this.#poll = setInterval(() => {
      if (!this.pending && this.#loadsInFlight === 0) this.load();
    }, AUTOMATION_POLL_MS);
  }

  stopPolling(): void {
    if (this.#poll === undefined) return;
    clearInterval(this.#poll);
    this.#poll = undefined;
  }

  clearErrors(): void {
    this.#set({ formError: "", actionError: "" });
  }

  #mutate(
    mutate: () => Promise<AutomationSnapshot | void>,
    /** Where a rejection belongs: the create form, or the list that was acted on. */
    surface: "form" | "action",
  ): Promise<boolean> {
    if (this.pending) return Promise.resolve(false);
    this.#set({ pending: true, formError: "", actionError: "" });
    return mutate()
      .then((snapshot) => {
        if (snapshot) {
          this.#loadRequest += 1;
          this.#set({ snapshot });
        } else this.load();
        return true;
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "The automation request failed.";
        if (surface === "form") this.#set({ formError: message });
        else this.#set({ actionError: message });
        return false;
      })
      .finally(() => {
        this.#set({ pending: false });
      });
  }

  create = (input: AutomationTaskInput) => this.#mutate(() => this.#api.createAutomationTask(input), "form");

  edit = (task: AutomationTask) => {
    this.#set({ editingId: task.id, formError: "" });
    queueMicrotask(() => this.#host.renderRoot.querySelector<HTMLFormElement>("#automation-task-form")?.scrollIntoView({ block: "start" }));
  };

  cancelEdit = () => {
    this.#set({ editingId: "", formError: "" });
  };

  update = (task: AutomationTask, input: AutomationTaskInput) =>
    this.#mutate(() => this.#api.updateAutomationTask(task.id, input), "form");

  setEnabled = (task: AutomationTask, enabled: boolean) => {
    void this.#mutate(() =>
      this.#api.updateAutomationTask(task.id, {
        name: task.name,
        description: task.description,
        sessionId: task.sessionId,
        prompt: task.prompt,
        schedule: task.schedule,
        enabled,
        timeoutSeconds: task.timeoutSeconds,
      }),
      "action",
    );
  };

  delete = (task: AutomationTask) => {
    void this.#mutate(() => this.#api.deleteAutomationTask(task.id), "action");
  };

  run = (task: AutomationTask) => {
    void this.#mutate(async () => {
      await this.#api.runAutomationTask(task.id);
    }, "action");
  };

  cancelRun = (run: AutomationRun) => {
    void this.#mutate(async () => {
      await this.#api.cancelAutomationRun(run.id);
    }, "action");
  };

  reportFormError = (message: string) => {
    this.#set({ formError: message });
  };

  props(): Omit<AutomationProps, "sessions" | "bots"> {
    return {
      automation: this.snapshot,
      automationError: this.error,
      automationPending: this.pending,
      automationFormError: this.formError,
      automationActionError: this.actionError,
      onRetryAutomation: this.load,
      onCreateAutomationTask: this.create,
      automationEditingId: this.editingId,
      onEditAutomationTask: this.edit,
      onCancelAutomationEdit: this.cancelEdit,
      onUpdateAutomationTask: this.update,
      onAutomationFormError: this.reportFormError,
      onSetAutomationEnabled: this.setEnabled,
      onDeleteAutomationTask: this.delete,
      onRunAutomationTask: this.run,
      onCancelAutomationRun: this.cancelRun,
    };
  }
}

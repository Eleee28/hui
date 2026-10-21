/**
 * `LaunchController` owns the New Session page's launch state outside `hui-app.ts`: the group defaults it opened with,
 * the workers and the sticky worker, the launch model, thinking and fast choices, the folder suggestions and the
 * machine they came from, and the inspected Git checkout with its branch, worktree and base ref defaults. The shell
 * sends the launch itself and decides when to load these.
 */
import type { ReactiveControllerHost } from "lit";
import { loadGitCheckout, type GitCheckoutInfo, type SessionGroup } from "../api/sessions.ts";
import { loadWorkingDirectorySuggestions } from "../api/working-directories.ts";
import { loadWorkers, type WorkerView } from "../api/workers.ts";
import { groupCheckoutDefaults } from "../lib/group-session-defaults.ts";
import type { PiSnapshot } from "../lib/pi.ts";
import type { HomeProps } from "../views/home.ts";

type LaunchDefaults = { group: string; cwd: string; workspaceMode?: "branch" | "worktree"; baseRef?: string };

export class LaunchController {
  defaults: LaunchDefaults | undefined;
  workers: readonly WorkerView[] = [];
  /** Sticky across launches: the worker new sessions run on, if any. */
  worker: string | undefined;
  model = "";
  thinking = "";
  fast = false;
  directorySuggestions: readonly string[] = [];
  /** The machine `directorySuggestions` came from: "" for this one, else a worker's id. A bot's Settings page shows only
   * its own machine's, so a bot on a worker is never offered this machine's folders. */
  directorySuggestionsFrom = "";
  branch = "";
  worktree = false;
  baseRef = "";
  branchSuggestionsOpen = false;
  checkout: GitCheckoutInfo | undefined;
  checkoutLoading = false;
  readonly #host: ReactiveControllerHost;
  #directoryRequest = 0;
  #checkoutRequest = 0;
  #inspectedDirectory = "";

  constructor(host: ReactiveControllerHost) {
    this.#host = host;
  }

  open(group?: SessionGroup): void {
    this.defaults = group
      ? {
          group: group.label === "ungrouped" ? "" : group.label,
          cwd: group.cwd ?? group.sessions[0]?.cwd ?? "",
          ...(group.workspaceMode ? { workspaceMode: group.workspaceMode } : {}),
          ...(group.baseRef ? { baseRef: group.baseRef } : {}),
        }
      : undefined;
    this.resetWorkspace();
    this.branchSuggestionsOpen = false;
    this.checkout = undefined;
    this.#inspectedDirectory = "";
  }

  resetWorkspace(): void {
    this.branch = "";
    this.worktree = false;
    this.baseRef = "";
    this.#host.requestUpdate();
  }

  loadDirectorySuggestions(input: string, worker?: string): void {
    const marker = ++this.#directoryRequest;
    void loadWorkingDirectorySuggestions(input, worker).then((directories) => {
      if (marker !== this.#directoryRequest) return;
      this.directorySuggestionsFrom = worker ?? "";
      this.directorySuggestions = directories;
      this.#host.requestUpdate();
    }).catch(() => {
      if (marker !== this.#directoryRequest) return;
      this.directorySuggestions = [];
      this.#host.requestUpdate();
    });
  }

  requestCheckout(input: string): void {
    const directory = input.trim() || "~/";
    if (directory === this.#inspectedDirectory && this.checkout) return;
    this.#inspectedDirectory = directory;
    const marker = ++this.#checkoutRequest;
    this.worktree = false;
    this.baseRef = "";
    this.checkoutLoading = true;
    this.#host.requestUpdate();
    void loadGitCheckout(directory).then((checkout) => {
      if (marker !== this.#checkoutRequest) return;
      this.checkout = checkout;
      const defaults = groupCheckoutDefaults(directory, checkout, this.defaults);
      this.baseRef = defaults.baseRef;
      this.worktree = defaults.worktree;
    }).catch(() => {
      if (marker !== this.#checkoutRequest) return;
      this.checkout = undefined;
    }).finally(() => {
      if (marker === this.#checkoutRequest) this.checkoutLoading = false;
      this.#host.requestUpdate();
    });
  }

  seedPreferences(snapshot: PiSnapshot, primary: string): void {
    const model = this.model || primary || (
      snapshot.model.defaultProvider && snapshot.model.defaultModel
        ? `${snapshot.model.defaultProvider}/${snapshot.model.defaultModel}`
        : ""
    );
    const thinking = this.thinking || (snapshot.model.thinking ?? "medium");
    if (model !== this.model || thinking !== this.thinking) this.#set({ model, thinking });
  }

  selectModel(model: string): void {
    this.#set({ model });
  }

  loadWorkers(): void {
    void loadWorkers().then((list) => {
      this.workers = list;
      if (this.worker && !list.some((worker) => worker.id === this.worker)) this.worker = undefined;
      this.#host.requestUpdate();
    }).catch(() => undefined);
  }

  #set(patch: Partial<Pick<LaunchController, "model" | "thinking" | "fast" | "worker" | "worktree" | "baseRef" | "branch" | "branchSuggestionsOpen">>): void {
    Object.assign(this, patch);
    this.#host.requestUpdate();
  }

  props(): Pick<HomeProps,
    "launchDefaults" | "launchThinking" | "onSelectLaunchModel" | "onSelectLaunchThinking" | "launchFast" | "onSelectLaunchFast"
    | "launchWorkers" | "launchWorker" | "onSelectLaunchWorker" | "directorySuggestions" | "gitCheckout" | "gitCheckoutLoading"
    | "workspaceWorktree" | "workspaceBaseRef" | "workspaceBranchSuggestionsOpen" | "workspaceBranch"
    | "onWorkspaceMode" | "onWorkspaceBaseRef" | "onWorkspaceBranchSuggestionsOpen" | "onWorkspaceBranch"> {
    return {
      launchDefaults: this.defaults,
      launchThinking: this.thinking || "medium",
      onSelectLaunchModel: (provider, modelId) => this.#set({ model: `${provider}/${modelId}` }),
      onSelectLaunchThinking: (thinking) => this.#set({ thinking }),
      launchFast: this.fast,
      onSelectLaunchFast: (fast) => this.#set({ fast }),
      launchWorkers: this.workers,
      ...(this.worker ? { launchWorker: this.worker } : {}),
      onSelectLaunchWorker: (worker) => {
        ++this.#directoryRequest;
        this.directorySuggestions = [];
        this.#set({ worker });
      },
      directorySuggestions: this.directorySuggestions,
      gitCheckout: this.checkout,
      gitCheckoutLoading: this.checkoutLoading,
      workspaceWorktree: this.worktree,
      workspaceBaseRef: this.baseRef,
      workspaceBranchSuggestionsOpen: this.branchSuggestionsOpen,
      workspaceBranch: this.branch,
      onWorkspaceMode: (worktree) => this.#set({ worktree, branchSuggestionsOpen: false }),
      onWorkspaceBaseRef: (baseRef) => this.#set({ baseRef }),
      onWorkspaceBranchSuggestionsOpen: (branchSuggestionsOpen) => this.#set({ branchSuggestionsOpen }),
      onWorkspaceBranch: (branch) => this.#set({ branch }),
    };
  }
}

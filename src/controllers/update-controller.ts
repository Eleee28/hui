/**
 * `UpdateController` keeps HUI's own update outside `hui-app.ts`: the background availability check behind the update
 * notice, the dismissed version, and the update dialog's check, install and the poll that follows a running update
 * until it reports completion. The shell opens the update session; this controller owns everything after it.
 */
import type { ReactiveController, ReactiveControllerHost } from "lit";
import { checkUpdate, checkUpdateInBackground, installUpdate, loadUpdate } from "../api/update.ts";
import { closeModal } from "../lib/modal-dialog.ts";
import { availableUpdate, watchUpdateAvailability } from "../lib/update-notice.ts";
import type { UpdateSnapshot } from "../api/schema/updates.ts";

type UpdateHost = ReactiveControllerHost & { renderRoot: ParentNode };

export class UpdateController implements ReactiveController {
  open = false;
  checking = false;
  starting = false;
  readOnly = false;
  error = "";
  reconnecting = false;
  snapshot: UpdateSnapshot | null = null;
  dismissedVersion = "";
  readonly #host: UpdateHost;
  readonly #focusFallback: () => void;
  #monitor: ReturnType<typeof watchUpdateAvailability> | undefined;
  #returnFocus: HTMLElement | null = null;
  #pollTimer: number | undefined;
  #pollDeadline = 0;
  readonly #onVisibility = () => this.#monitor?.refresh();

  constructor(host: UpdateHost, focusFallback: () => void) {
    this.#host = host;
    this.#focusFallback = focusFallback;
    host.addController(this);
  }

  #changed(): void {
    this.#host.requestUpdate();
  }

  watch(): void {
    this.#monitor = watchUpdateAvailability({
      check: checkUpdateInBackground,
      receive: (snapshot) => {
        if (!this.open && !this.starting) {
          this.snapshot = snapshot;
          this.#changed();
        }
      },
      enabled: () => document.visibilityState === "visible" && navigator.onLine && !this.open && !this.starting,
    });
    document.addEventListener("visibilitychange", this.#onVisibility);
    window.addEventListener("online", this.#onVisibility);
    window.addEventListener("offline", this.#onVisibility);
    window.addEventListener("focus", this.#onVisibility);
  }

  hostDisconnected(): void {
    document.removeEventListener("visibilitychange", this.#onVisibility);
    window.removeEventListener("online", this.#onVisibility);
    window.removeEventListener("offline", this.#onVisibility);
    window.removeEventListener("focus", this.#onVisibility);
    this.#monitor?.stop();
    this.#monitor = undefined;
    if (this.#pollTimer !== undefined) window.clearTimeout(this.#pollTimer);
  }

  review(returnFocus: HTMLElement | null, readOnly: boolean, openSession: () => Promise<boolean>): void {
    this.#returnFocus = returnFocus;
    this.readOnly = readOnly;
    this.#changed();
    void openSession().then((opened) => {
      if (!opened) return;
      this.open = true;
      this.#changed();
      void this.check();
    });
  }

  check = async () => {
    if (this.checking || this.starting) return;
    this.checking = true;
    this.error = "";
    this.reconnecting = false;
    this.#changed();
    try {
      this.snapshot = await loadUpdate();
      this.#changed();
      if (this.snapshot.job?.status === "running") this.#beginPolling();
      else this.snapshot = await checkUpdate();
    } catch (error) { this.error = error instanceof Error ? error.message : "Could not check for updates."; }
    finally {
      this.checking = false;
      this.#changed();
    }
  };

  install = async () => {
    const version = this.snapshot?.check?.latest?.version;
    if (!version || !this.snapshot?.check?.canInstall || this.readOnly || this.starting) return;
    this.starting = true;
    this.error = "";
    this.#changed();
    try {
      this.snapshot = await installUpdate(version);
      this.#beginPolling();
    } catch (error) { this.error = error instanceof Error ? error.message : "Could not start the update."; }
    finally {
      this.starting = false;
      this.#changed();
    }
  };

  #beginPolling() {
    if (this.#pollTimer !== undefined) window.clearTimeout(this.#pollTimer);
    this.#pollDeadline = Date.now() + 10 * 60_000;
    if (this.open) this.#pollTimer = window.setTimeout(() => void this.#poll(), 1000);
  }

  async #poll() {
    if (!this.open) return;
    try {
      this.snapshot = await loadUpdate();
      this.reconnecting = false;
      this.#changed();
      if (this.snapshot.job?.status !== "running") return;
    } catch {
      this.reconnecting = true;
      this.#changed();
    }
    if (Date.now() >= this.#pollDeadline) {
      this.error = "The update has not reported completion. Check hui gateway status and logs, then reopen /update.";
      this.#changed();
      return;
    }
    if (this.open) this.#pollTimer = window.setTimeout(() => void this.#poll(), 1000);
  }

  close = () => {
    closeModal(this.#host.renderRoot.querySelector<HTMLDialogElement>(".hui-update-dialog") ?? undefined);
    this.open = false;
    this.#changed();
    if (this.#pollTimer !== undefined) window.clearTimeout(this.#pollTimer);
    if (this.#returnFocus?.isConnected) this.#returnFocus.focus();
    else this.#focusFallback();
    this.#returnFocus = null;
    this.#monitor?.refresh();
  };

  dismiss(): void {
    this.dismissedVersion = this.snapshot?.check?.latest?.version ?? "";
    this.#changed();
  }

  release() {
    return availableUpdate(this.snapshot, this.dismissedVersion);
  }

  dialogProps() {
    return { open: this.open, checking: this.checking, starting: this.starting,
      readOnly: this.readOnly, error: this.error, reconnecting: this.reconnecting, snapshot: this.snapshot,
      onCheck: () => void this.check(), onInstall: () => void this.install(), onClose: this.close,
      onReload: () => window.location.reload() };
  }
}

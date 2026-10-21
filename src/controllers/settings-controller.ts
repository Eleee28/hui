/**
 * `SettingsController` keeps the settings state outside `hui-app.ts`: the HUI settings and their saves, the theme
 * picker and imports, PI's configuration and its package and skill changes, the resource reader, and the control
 * surfaces (gateway health, macOS power, the workspace inspection and observability). Settings elements that load
 * their own data keep their own requests.
 */
import type { ReactiveController, ReactiveControllerHost } from "lit";
import { downloadDiagnostics, loadObservability, type ObservabilitySnapshot } from "../api/observability.ts";
import { installPiPackage, installPiSkill, loadPiConfig, loadPiResource, removePiPackage } from "../api/pi.ts";
import {
  loadGatewayHealth,
  loadPower,
  loadWorkspaceInspection,
  setLidAwake,
  type GatewayHealth,
  type WorkspaceInspection,
} from "../api/control-surfaces.ts";
import { writeClipboardText } from "../lib/clipboard.ts";
import { closeModal } from "../lib/modal-dialog.ts";
import type { HuiPage } from "../lib/pages.ts";
import { skillPreferencePath, type PiMutationKind, type PiMutationResult, type PiMutationState, type PiSnapshot } from "../lib/pi.ts";
import type { Settings } from "../lib/settings/settings.ts";
import { currentSettings, patchSettings } from "../lib/settings/settings-store.ts";
import type { ThemeMode, ThemeVariant } from "../lib/theme/theme.ts";
import {
  applyAccent,
  applyMode,
  applyTheme,
  importTheme,
  loadThemePreviews,
  selectedThemeId,
  selectedThemeVariant,
  type ThemePreview,
} from "../lib/theme/theme-store.ts";
import type { PiResourceReaderState } from "../views/pi-resource-reader.ts";
import type { AutomationProps } from "../views/settings-automation.ts";
import type { SettingsProps } from "../views/settings.ts";
import type { PowerStatus } from "../api/schema/power.ts";

type SettingsHost = ReactiveControllerHost & { renderRoot: ParentNode };

type SettingsEvents = {
  piLoaded: (snapshot: PiSnapshot) => void;
  copyFailed: (message: string) => void;
};

export class SettingsController implements ReactiveController {
  settings: Settings = currentSettings();
  saveFailed = false;
  themeId: string = selectedThemeId();
  variant: ThemeVariant = selectedThemeVariant();
  previews: readonly ThemePreview[] = [];
  themeImportNote = "";
  themeImportFailed = false;
  /** `undefined` until the backend answers, so an empty list never reads as "none". */
  pi: PiSnapshot | undefined;
  piLoading = false;
  piError = "";
  piOperation: PiMutationState | undefined;
  piRemoveCandidate = "";
  piResourceReader: PiResourceReaderState | undefined;
  health: GatewayHealth | undefined;
  healthError = "";
  /** macOS sleep prevention; `null` when the gateway is not on macOS. */
  power: PowerStatus | null | undefined;
  powerNoticeDismissed = false;
  workspaceInspection: WorkspaceInspection | undefined;
  workspaceError = "";
  controlLoading = false;
  observability: ObservabilitySnapshot | undefined;
  observabilityLoading = false;
  observabilityError = "";
  readonly #host: SettingsHost;
  readonly #events: SettingsEvents;
  #saveRevision = 0;
  #healthPending = false;
  #powerRequest = 0;
  #piRequest: Promise<void> | undefined;
  #readerReturnFocus: HTMLElement | undefined;
  #readerRequest = 0;
  #copyTimer: number | undefined;

  constructor(host: SettingsHost, events: SettingsEvents) {
    this.#host = host;
    this.#events = events;
    host.addController(this);
  }

  hostDisconnected(): void {
    this.#clearCopyTimer();
  }

  #changed(): void {
    this.#host.requestUpdate();
  }

  async save(patch: Partial<Settings>) {
    const revision = ++this.#saveRevision;
    const pending = patchSettings(patch);
    // Render the store's optimistic snapshot before another control builds a
    // nested patch. Waiting for disk here reintroduced stale Labs/Chat values.
    this.settings = currentSettings();
    this.#changed();
    const saved = await pending;
    if (revision !== this.#saveRevision) return;
    this.saveFailed = !saved;
    this.settings = currentSettings();
    this.#changed();
  }

  patchOwnedSettings = (patch: Partial<Settings>) => {
    void this.save(patch);
  };

  loadPreviews(): void {
    void loadThemePreviews().then((previews) => {
      this.previews = previews;
      this.#changed();
    });
  }

  chooseMode = (mode: ThemeMode) => {
    applyMode(mode);
    void this.save({ themeMode: mode });
  };

  chooseTheme = (id: string) => {
    void this.#applyTheme(id);
  };

  chooseAccent = (accent: string) => {
    applyAccent(accent);
    void this.save({ accent });
  };

  async #applyTheme(id: string) {
    // Read the selection back rather than assuming it: a theme whose file fails
    // to load is not applied, and the picker has to snap back to the old one.
    const variant = await applyTheme(id);
    this.themeId = selectedThemeId();
    this.variant = variant ?? this.variant;
    this.#changed();
    if (variant) {
      await this.save({ theme: selectedThemeId() });
    }
  }

  importTheme = (url: string) => {
    this.themeImportNote = "Importing…";
    this.themeImportFailed = false;
    this.#changed();
    void importTheme(url)
      .then(async (id) => {
        this.previews = await loadThemePreviews();
        this.themeImportNote = `Imported ${id}.`;
        this.themeImportFailed = false;
        this.#changed();
        await this.#applyTheme(id);
      })
      .catch((error: unknown) => {
        this.themeImportNote = error instanceof Error ? error.message : "Import failed.";
        this.themeImportFailed = true;
        this.#changed();
      });
  };

  async refreshGatewayHealth() {
    if (this.#healthPending || this.controlLoading) return;
    this.#healthPending = true;
    try {
      this.health = await loadGatewayHealth();
      this.healthError = "";
    } catch (error) {
      this.healthError = error instanceof Error ? error.message : "Could not read gateway health.";
    } finally {
      this.#healthPending = false;
      this.#changed();
    }
  }

  /** The newest request wins, so an older poll never undoes a click. */
  async refreshPower(next?: Promise<PowerStatus | null>) {
    const request = ++this.#powerRequest;
    let power: PowerStatus | null | undefined;
    try {
      power = await (next ?? loadPower());
    } catch {
      // Unknown rather than stale: no banner or switches until the gateway answers.
    }
    if (request !== this.#powerRequest) return;
    this.power = power;
    if (!power?.lidOn) this.powerNoticeDismissed = false;
    this.#changed();
  }

  setLidAwake = (on: boolean) => void this.refreshPower(setLidAwake(on));

  dismissPowerNotice(): void {
    this.powerNoticeDismissed = true;
    this.#changed();
  }

  loadStale(): void {
    const stale = Boolean(this.piError || this.healthError || this.workspaceError);
    if (stale || !this.pi || !this.health || !this.workspaceInspection) {
      this.loadControlSurfaceData(stale);
    }
  }

  loadControlSurfaceData = (force = false) => {
    if (this.controlLoading) return;
    if (!force && this.pi && this.health && this.workspaceInspection) return;
    this.controlLoading = true;
    this.piLoading = true;
    this.piError = "";
    this.healthError = "";
    this.workspaceError = "";
    this.#changed();
    void Promise.allSettled([loadPiConfig(), loadGatewayHealth(), loadWorkspaceInspection()])
      .then(([pi, health, workspaces]) => {
        const message = (reason: unknown, fallback: string) =>
          reason instanceof Error ? reason.message : fallback;
        if (pi.status === "fulfilled") {
          this.pi = pi.value;
          this.#events.piLoaded(pi.value);
        }
        else this.piError = message(pi.reason, "Could not read PI configuration.");
        if (health.status === "fulfilled") this.health = health.value;
        else this.healthError = message(health.reason, "Could not read gateway health.");
        if (workspaces.status === "fulfilled") this.workspaceInspection = workspaces.value;
        else this.workspaceError = message(workspaces.reason, "Could not inspect workspaces.");
      })
      .finally(() => {
        this.controlLoading = false;
        this.piLoading = false;
        this.#changed();
      });
  };

  loadPi(): void {
    if (this.#piRequest) return;
    this.piLoading = true;
    this.#changed();
    this.#piRequest = loadPiConfig()
      .then((snapshot) => {
        this.pi = snapshot;
        this.piError = "";
        this.#events.piLoaded(snapshot);
      })
      .catch((error: unknown) => {
        this.piError = error instanceof Error ? error.message : "Could not read PI configuration.";
      })
      .finally(() => {
        this.piLoading = false;
        this.#piRequest = undefined;
        this.#changed();
      });
  }

  #runPiMutation(
    kind: PiMutationKind,
    target: string,
    operation: () => Promise<PiMutationResult>,
  ) {
    if (this.piOperation?.status === "running") return;
    this.piOperation = { kind, target, status: "running", message: kind === "skill-install" ? "The installer agent is inspecting the skill source." : "PI is updating its package configuration." };
    this.#changed();
    void operation()
      .then((result) => {
        this.pi = result.snapshot;
        this.piOperation = { kind, target: result.target, status: "ok", message: result.message };
        this.piRemoveCandidate = "";
      })
      .catch((error: unknown) => {
        this.piOperation = {
          kind,
          target,
          status: "error",
          message: error instanceof Error ? error.message : "PI operation failed.",
        };
      })
      .finally(() => this.#changed());
  }

  installPiPackage = (url: string) => {
    this.#runPiMutation("package-install", url, () => installPiPackage(url));
  };

  requestPiPackageRemoval = (source: string) => {
    this.piRemoveCandidate = source;
    this.#changed();
  };

  cancelPiPackageRemoval = () => {
    this.piRemoveCandidate = "";
    this.#changed();
  };

  removePiPackage = (source: string) => {
    this.#runPiMutation("package-remove", source, () => removePiPackage(source));
  };

  installPiSkill = (url: string) => {
    this.#runPiMutation("skill-install", url, () => installPiSkill(url));
  };

  setPiSkillEnabled = (skill: PiSnapshot["skills"][number], enabled: boolean) => {
    const disabledSkills = this.settings.disabledSkills.filter((entry) => entry.path !== skillPreferencePath(skill) && entry.path !== skill.path);
    if (!enabled) disabledSkills.push({ name: skill.name, path: skillPreferencePath(skill) });
    void this.save({ disabledSkills });
  };

  setPiPluginEnabled = (resource: PiSnapshot["settings"]["resources"][number], enabled: boolean) => {
    const disabledPlugins = this.settings.disabledPlugins.filter((entry) => entry.id !== resource.id);
    if (!enabled) disabledPlugins.push({ id: resource.id, name: resource.label, kind: resource.kind });
    void this.save({ disabledPlugins });
  };

  #clearCopyTimer(): void {
    if (this.#copyTimer !== undefined) window.clearTimeout(this.#copyTimer);
    this.#copyTimer = undefined;
  }

  readPiResource = (kind: "skill" | "plugin", resource: { id: string; name?: string; label?: string }) => {
    const title = resource.name ?? resource.label ?? "PI resource";
    const request = ++this.#readerRequest;
    this.#clearCopyTimer();
    this.#readerReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    this.piResourceReader = { title, status: "loading" };
    this.#changed();
    void loadPiResource(kind, resource.id).then(
      (document) => {
        if (request !== this.#readerRequest) return;
        this.piResourceReader = { title, status: "ready", document };
        this.#changed();
      },
      (error: unknown) => {
        if (request !== this.#readerRequest) return;
        this.piResourceReader = { title, status: "error", error: error instanceof Error ? error.message : "Could not read this resource." };
        this.#changed();
      },
    );
  };

  copyPiResource = () => {
    const reader = this.piResourceReader;
    if (!reader?.document) return;
    const resourceId = reader.document.id;
    void writeClipboardText(reader.document.content).then((copied) => {
      if (!copied) throw new Error("Clipboard write failed");
      if (this.piResourceReader !== reader) return;
      this.piResourceReader = { ...reader, copied: true };
      this.#changed();
      this.#clearCopyTimer();
      this.#copyTimer = window.setTimeout(() => {
        const current = this.piResourceReader;
        if (current && current.document?.id === resourceId) {
          this.piResourceReader = { ...current, copied: false };
          this.#changed();
        }
      }, 1_500);
    }).catch(() => {
      this.#events.copyFailed("Could not copy the resource to the clipboard.");
    });
  };

  closePiResourceReader = () => {
    this.#readerRequest += 1;
    this.#clearCopyTimer();
    closeModal(this.#host.renderRoot.querySelector<HTMLDialogElement>(".pi-resource-reader-modal") ?? undefined);
    this.piResourceReader = undefined;
    this.#changed();
    const target = this.#readerReturnFocus;
    this.#readerReturnFocus = undefined;
    target?.focus();
  };

  loadObservability(force: boolean): void {
    if (!force && this.observability) return;
    this.observabilityLoading = true;
    this.observabilityError = "";
    this.#changed();
    void loadObservability()
      .then((snapshot) => { this.observability = snapshot; })
      .catch((error: unknown) => { this.observabilityError = error instanceof Error ? error.message : "Could not read observability state."; })
      .finally(() => {
        this.observabilityLoading = false;
        this.#changed();
      });
  }

  exportDiagnostics = () => {
    void downloadDiagnostics().catch((error: unknown) => {
      this.observabilityError = error instanceof Error ? error.message : "Could not export diagnostics.";
      this.#changed();
    });
  };

  controlSurfaceError(page: HuiPage): string {
    if (page.id === "connection") return [this.piError, this.healthError].filter(Boolean).join(" ");
    if (page.id === "memory-import") return this.workspaceError;
    return this.piError;
  }

  props(): Omit<SettingsProps, keyof AutomationProps | "page" | "worktrees" | "onRefreshObservability" | "onSelectPage" | "onChangeModels" | "onClose"> {
    return {
      pi: this.pi,
      piLoading: this.piLoading,
      piError: this.piError,
      health: this.health,
      healthError: this.healthError,
      power: this.power,
      workspaces: this.workspaceInspection,
      workspaceError: this.workspaceError,
      observability: this.observability,
      observabilityError: this.observabilityError,
      onExportDiagnostics: this.exportDiagnostics,
      onRetryPi: () => this.loadControlSurfaceData(true),
      previews: this.previews,
      settings: this.settings,
      themeId: this.themeId,
      variant: this.variant,
      saveFailed: this.saveFailed,
      importNote: this.themeImportNote,
      importFailed: this.themeImportFailed,
      onSelectTheme: this.chooseTheme,
      onSelectMode: this.chooseMode,
      onSelectAccent: this.chooseAccent,
      onChangeBranchPrefix: (branchPrefix) => void this.save({ branchPrefix }),
      onChangeAppearance: (next) => void this.save(next),
      onChangeChat: (chat) => void this.save({ chat }),
      onChangeBrowser: (browser) => this.save({ browser }),
      onChangeVscode: (vscode) => this.save({ vscode }),
      onChangeCodemode: (codemode) => void this.save({ codemode }),
      onChangeQuestions: (questions) => void this.save({ questions }),
      onChangeCalls: (calls) => void this.save({ calls }),
      onChangePower: (power) => void this.save({ power }).then(() => this.refreshPower()),
      onSetLidAwake: this.setLidAwake,
      onImportTheme: this.importTheme,
      piOperation: this.piOperation,
      piRemoveCandidate: this.piRemoveCandidate,
      onInstallPackage: this.installPiPackage,
      onRequestRemovePackage: this.requestPiPackageRemoval,
      onCancelRemovePackage: this.cancelPiPackageRemoval,
      onConfirmRemovePackage: this.removePiPackage,
      onInstallSkill: this.installPiSkill,
      onSetSkillEnabled: this.setPiSkillEnabled,
      onSetPluginEnabled: this.setPiPluginEnabled,
      onReadSkill: (skill) => this.readPiResource("skill", skill),
      onReadPlugin: (resource) => this.readPiResource("plugin", resource),
    };
  }
}

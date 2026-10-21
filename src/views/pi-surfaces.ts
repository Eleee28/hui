/**
 * The pages that report PI's own setup: connection, model providers and setup, config, skills, plugins and memory
 * import. PI owns the data; these views show the snapshot and route installs, removals and enable switches back to
 * the app, which asks the gateway to apply them.
 */
import { html, nothing, type TemplateResult } from "lit";

import type { GatewayHealth, WorkspaceInspection } from "../api/control-surfaces.ts";
import type { HuiPage } from "../lib/pages.ts";
import { skillIsEnabled, type PiMutationState, type PiSnapshot } from "../lib/pi.ts";
import { icons } from "../lib/icons.ts";
import { renderProviderBrandIcon } from "../lib/provider-icons.ts";
import { renderListFilter } from "../components/list-filter.ts";
import { renderSettingsToggle } from "./settings-toggle.ts";

export type PiSurfaceProps = {
  page: HuiPage;
  pi: PiSnapshot | undefined;
  health: GatewayHealth | undefined;
  workspaces: WorkspaceInspection | undefined;
  loading: boolean;
  error: string;
  onRefresh: () => void;
  onSessions: () => void;
  onOpenSettings: (page: "appearance" | "connection" | "models" | "plugins" | "skills" | "memory") => void;
  operation?: PiMutationState;
  removeCandidate: string;
  onInstallPackage: (url: string) => void;
  onRequestRemovePackage: (source: string) => void;
  onCancelRemovePackage: () => void;
  onConfirmRemovePackage: (source: string) => void;
  onInstallSkill: (url: string) => void;
  disabledSkills: readonly { name: string; path: string }[];
  onSetSkillEnabled: (skill: PiSnapshot["skills"][number], enabled: boolean) => void;
  disabledPlugins: readonly { id: string; name: string; kind: "package" | "extension" }[];
  onSetPluginEnabled: (resource: PiSnapshot["settings"]["resources"][number], enabled: boolean) => void;
  onReadSkill: (skill: PiSnapshot["skills"][number]) => void;
  onReadPlugin: (resource: PiSnapshot["settings"]["resources"][number]) => void;
};

const IMPLEMENTED_PI_SURFACES = new Set([
  "config",
  "connection",
  "model-providers",
  "model-setup",
  "plugins",
  "plugin",
  "skills",
  "skill-workshop",
  "memory-import",
]);

export function isPiSurface(page: HuiPage): boolean {
  return IMPLEMENTED_PI_SURFACES.has(page.id);
}

function status(kind: "ok" | "warn" | "muted", label: string) {
  return html`<span class="settings-status ${kind === "muted" ? "" : `settings-status--${kind}`}"><span class="settings-status__dot" aria-hidden="true"></span>${label}</span>`;
}

function row(title: string | TemplateResult, description: string, value: TemplateResult | string, filter?: string) {
  return html`<div class="settings-row" data-filter=${filter ?? nothing}>
    <div class="settings-row__text">
      <span class="settings-row__title">${title}</span>
      <span class="settings-row__desc">${description}</span>
    </div>
    <div class="settings-row__control">${value}</div>
  </div>`;
}

function section(title: string, description: TemplateResult | string, body: TemplateResult, action = nothing) {
  return html`<section class="settings-section">
    <header class="settings-section__header">
      <div class="settings-section__copy">
        <h2 class="settings-section__heading">${title}</h2>
        <p class="settings-section__desc">${description}</p>
      </div>
      ${action}
    </header>
    <div class="settings-group">${body}</div>
  </section>`;
}

function pageHeader(props: PiSurfaceProps, title: string, subtitle: string, tabs?: TemplateResult) {
  return html`<header class="content-header content-header--settings content-header--page ${tabs ? "hub-page-header" : ""}">
    <div class=${tabs ? "hub-page-header__title" : ""}>
      <div class="page-title">${title}</div>
      <div class="page-subtitle">${subtitle}</div>
    </div>
    ${tabs ? html`<div class="hub-page-header__tabs">${tabs}</div>` : nothing}
    <div class="page-header-actions ${tabs ? "hub-page-header__actions" : ""}"><button type="button" class="btn" ?disabled=${props.loading} @click=${() => props.onRefresh()}>
      ${icons.refresh}<span>${props.loading ? "Refreshing…" : "Refresh"}</span>
    </button></div>
  </header>${props.error ? html`<div class="callout warning" role="alert">${props.error}</div>` : nothing}`;
}

function urlSubmit(callback: (url: string) => void) {
  return (event: SubmitEvent) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    callback(String(new FormData(form).get("url") ?? "").trim());
  };
}

function operationNotice(props: PiSurfaceProps, kind: PiMutationState["kind"]) {
  const operation = props.operation;
  if (!operation || operation.kind !== kind) return nothing;
  const role = operation.status === "error" ? "alert" : "status";
  return html`<div class="callout pi-operation pi-operation--${operation.status}" role=${role}>
    <strong>${operation.status === "running" ? "Working…" : operation.status === "ok" ? "OK" : "Error"}</strong>
    <span>${operation.message}</span>
  </div>`;
}

function installForm(
  props: PiSurfaceProps,
  kind: "package-install" | "skill-install",
  placeholder: string,
  button: string,
  submit: (url: string) => void,
) {
  const running = props.operation?.status === "running";
  return html`<form class="settings-row__control pi-install-form" @submit=${urlSubmit(submit)}>
    <input class="settings-input" aria-label=${kind === "package-install" ? "pi.dev package URL" : "Skill URL"} name="url" type="url" inputmode="url" autocomplete="url" placeholder=${placeholder} ?disabled=${running} />
    <button type="submit" class="btn" ?disabled=${running}>${running && props.operation?.kind === kind ? "Installing…" : button}</button>
  </form>`;
}

function unavailable(props: PiSurfaceProps) {
  if (props.error) {
    return html`<div class="callout danger" role="alert">${props.error}</div>`;
  }
  return html`<div class="settings-loading" role="status">Reading PI and HUI state…</div>`;
}

function providers(pi: PiSnapshot) {
  const catalog = new Map<string, typeof pi.model.catalog>();
  for (const model of pi.model.catalog) {
    catalog.set(model.provider, [...(catalog.get(model.provider) ?? []), model]);
  }
  const names = new Set([
    ...catalog.keys(),
    ...pi.model.authenticated,
    ...(pi.model.defaultProvider ? [pi.model.defaultProvider] : []),
  ]);
  return [...names].toSorted().map((name) => ({
    name,
    models: catalog.get(name) ?? [],
    authenticated: pi.model.authenticated.includes(name),
    primary: pi.model.defaultProvider === name,
  }));
}

function renderConnection(props: PiSurfaceProps) {
  const health = props.health;
  if (!health || !props.pi) return unavailable(props);
  return html`${pageHeader(props, "Connection", "Gateway access and live PI runtime state.")}
    <div class="settings-page pi-surface__body">
      ${section(
        "Access",
        `Connected to this HUI gateway · ${health.transport}`,
        html`${row("Gateway", "The local HUI backend serving this page.", status("ok", "Connected"))}
          ${row("Permissions", "HUI does not add an approval interception layer.", status("ok", health.access))}`,
      )}
      ${section(
        "System",
        "Read-only process and session health.",
        html`${row("Gateway uptime", "Time since the current HUI process started.", `${health.uptimeSeconds}s`)}
          ${row("PI agent directory", "Configuration source owned by PI.", html`<code>${props.pi.agentDir}</code>`)}
          ${row("Registered sessions", "Rows in HUI's own session registry.", String(health.sessions.registered))}
          ${row("Live runtimes", "PI processes currently owned by this gateway.", String(health.sessions.processes))}
          ${row("Running", "Sessions currently processing a turn.", String(health.sessions.running))}`,
      )}
    </div>`;
}

function renderModels(props: PiSurfaceProps, setup: boolean) {
  const pi = props.pi;
  if (!pi) return unavailable(props);
  const cards = providers(pi);
  return html`${pageHeader(
      props,
      setup ? "Model Setup" : "Model Providers",
      setup ? "Current PI defaults and usable model candidates." : "Providers and models reported by PI.",
    )}
    <div class="settings-page pi-surface__body">
      ${section(
        setup ? "Configured model" : "Default models",
        "Managed by PI. HUI never reads or writes credential values.",
        html`${row("Primary", "Used when a session does not override the model.", html`<strong>${pi.model.defaultProvider && pi.model.defaultModel ? `${pi.model.defaultProvider}/${pi.model.defaultModel}` : "PI default"}</strong>`)}
          ${row("Thinking", "Default reasoning level for new sessions.", pi.model.thinking ?? "PI default")}
          ${row("Available models", "Credential-filtered by PI's own RPC catalog.", String(pi.model.catalog.length))}`,
      )}
      ${section(
        "Providers",
        cards.length ? `${cards.length} provider${cards.length === 1 ? "" : "s"} available` : "No provider is currently available.",
        cards.length
          ? html`${cards.map((card) => html`<div class="settings-row settings-row--stacked model-providers__row" data-provider-id=${card.name}>
              <div class="model-providers__head"><div class="model-providers__identity">
                ${renderProviderBrandIcon(card.name, "model-providers__icon")}
                <div class="settings-row__text"><span class="settings-row__title">${card.name}</span><span class="settings-row__desc">${card.models.length} model${card.models.length === 1 ? "" : "s"}${card.primary ? " · default" : ""}</span></div>
              </div><div class="settings-row__control">${status(card.authenticated ? "ok" : card.models.length ? "ok" : "warn", card.authenticated ? "Credential configured" : card.models.length ? "Available" : "Needs setup")}</div></div>
            </div>`)}`
          : row("No providers", "Configure a provider with PI, then refresh this page.", status("warn", "Unavailable")),
      )}
      ${setup && pi.model.catalog.length
        ? section(
            "Model catalog",
            "Candidates returned by PI. Choose a model per session from the chat composer.",
            html`${pi.model.catalog.map((model) => row(model.name, `${model.provider}/${model.id}`, status("ok", "Available")))}`,
          )
        : nothing}
    </div>`;
}

function renderConfig(props: PiSurfaceProps) {
  const pi = props.pi;
  if (!pi) return unavailable(props);
  const link = (label: string, page: Parameters<PiSurfaceProps["onOpenSettings"]>[0]) =>
    html`<button type="button" class="btn" @click=${() => props.onOpenSettings(page)}>${label}</button>`;
  return html`${pageHeader(props, "Config", "Source-of-truth boundaries for HUI and PI.")}
    <div class="settings-page pi-surface__body">
      ${section(
        "HUI-owned",
        "HUI writes presentation preferences and HUI-only runtime policy.",
        html`${row("Appearance and local preferences", "Stored under HUI's XDG configuration directory.", link("Open Appearance", "appearance"))}
          ${row("Skill availability", "Disable a skill for HUI without changing its PI installation.", link("Open Skills", "skills"))}
          ${row("Plugin availability", "Exclude packages and extensions before the PI SDK loads resources.", link("Open Plugins", "plugins"))}`,
      )}
      ${section(
        "PI-owned",
        "PI remains the writer for agent behavior, auth, models, packages and skills; HUI delegates supported mutations back to PI.",
        html`${row("Settings", pi.settings.exists ? "PI settings file detected." : "PI is using defaults.", html`<code>${pi.settings.path}</code>`)}
          ${row("Models and auth", "Only safe names and availability are projected.", link("Open Models", "models"))}
          ${row("Skills and extensions", "Discovered from PI's configured roots.", link("Open Skills", "skills"))}`,
      )}
    </div>`;
}

function renderSkills(props: PiSurfaceProps) {
  const pi = props.pi;
  if (!pi) return unavailable(props);
  const byRoot = new Map<string, typeof pi.skills>();
  for (const skill of pi.skills) {
    const root = skill.origin === "hui" ? "HUI defaults" : skill.root;
    byRoot.set(root, [...(byRoot.get(root) ?? []), skill]);
  }
  return html`${pageHeader(props, "Skills", "PI skills and HUI defaults. Changes apply when a session runtime next starts.")}
    <div class="settings-page settings-page--wide pi-surface__body">
      ${section(
        "Install from URL",
        "A short-lived low-cost PI agent inspects the source and installs one Agent Skill. HUI reports success only after PI discovers it.",
        html`<div class="settings-row settings-row--stacked">
          ${installForm(props, "skill-install", "https://github.com/owner/skill", "Install skill", props.onInstallSkill)}
        </div>`,
      )}
      ${operationNotice(props, "skill-install")}
      ${pi.skills.length ? renderListFilter("Search skills") : nothing}
      ${[...byRoot.entries()].map(([root, skills]) => section(
        root,
        root === "HUI defaults" ? "Included with HUI · enabled by default · optional" : `${skills.length} skill${skills.length === 1 ? "" : "s"}`,
        html`${skills.map((skill) => {
          const enabled = skillIsEnabled(skill, props.disabledSkills);
          return row(
            html`${skill.name} ${skill.tags?.map((tag) => html`<span class="capability-badge">${tag}</span>`)}`,
            skill.description || "No description provided.",
            html`<button type="button" class="btn btn--icon pi-resource-read-button" aria-label=${`Read ${skill.name}`} title=${`Read ${skill.name}`} @click=${() => props.onReadSkill(skill)}>${icons.eye}</button>${skill.origin === "hui" ? nothing : html`<a class="btn btn--icon pi-resource-read-button" href=${`vscode://file${skill.path.split("/").map(encodeURIComponent).join("/")}`} aria-label=${`Edit ${skill.name} in VS Code`} title=${`Edit ${skill.name} in VS Code`}>${icons.edit}</a>`}${renderSettingsToggle(
              `Enable ${skill.name} in HUI`, enabled, (checked) => props.onSetSkillEnabled(skill, checked),
            )}`,
            `${skill.name} ${skill.description} ${skill.tags?.join(" ") ?? ""}`,
          );
        })}`,
      ))}
      ${byRoot.size === 0 ? section("Installed skills", "No skills were discovered.", row("No skills found", "Configure a PI skill root and refresh.", status("muted", "Empty"))) : nothing}
    </div>`;
}

function renderExtensions(props: PiSurfaceProps, workshop: boolean) {
  const pi = props.pi;
  if (!pi) return unavailable(props);
  if (workshop) {
    return html`${pageHeader(props, "Skill Workshop", "The OpenClaw workshop adapted to PI ownership boundaries.")}
      <div class="settings-page pi-surface__body">
        <div class="callout warning">Creating, revising and publishing skills stays disabled until HUI has an explicit storage, review and rollback contract.</div>
        ${section("Skill sources", "Current PI roots remain the source of truth.", html`${pi.settings.skillRoots.map((root) => row(root, "Read-only skill root", status("ok", "Discovered")))}`)}
      </div>`;
  }
  const resources = pi.settings.resources;
  return html`${pageHeader(props, "Plugins", "PI packages and extensions available to HUI runtimes.")}
    <div class="settings-page settings-page--wide pi-surface__body">
      ${section(
        "Add package",
        html`Paste a package page from <a href="https://pi.dev/packages" target="_blank" rel="noreferrer">pi.dev/packages</a>. PI performs the installation and remains the settings owner.`,
        html`<div class="settings-row settings-row--stacked">
          ${installForm(props, "package-install", "https://pi.dev/packages/package-name", "Install package", props.onInstallPackage)}
        </div>`,
      )}
      ${operationNotice(props, "package-install")}
      ${operationNotice(props, "package-remove")}
      ${resources.length ? renderListFilter("Search plugins") : nothing}
      ${section(
        "Installed",
        resources.length ? `${resources.length} configured source${resources.length === 1 ? "" : "s"}` : "PI is running without configured packages or extensions.",
        resources.length ? html`${resources.map((resource) => row(
          resource.label,
          props.removeCandidate === resource.label ? "Remove this package from PI settings?" : `${resource.kind === "package" ? "Managed by PI settings" : "Configured directly as a PI extension"}. Changes apply on next runtime start.`,
          html`<button type="button" class="btn btn--icon pi-resource-read-button" aria-label=${`Read ${resource.label}`} title=${`Read ${resource.label}`} @click=${() => props.onReadPlugin(resource)}>${icons.eye}</button>${renderSettingsToggle(
            `Enable ${resource.label} in HUI`,
            !props.disabledPlugins.some((entry) => entry.id === resource.id),
            (checked) => props.onSetPluginEnabled(resource, checked),
          )}${resource.kind === "package" && props.removeCandidate === resource.label
            ? html`
                <button type="button" class="btn" @click=${props.onCancelRemovePackage}>Cancel</button>
                <button type="button" class="btn danger" ?disabled=${props.operation?.status === "running"} @click=${() => props.onConfirmRemovePackage(resource.label)}>Remove</button>
              `
            : resource.kind === "package" ? html`
                <button type="button" class="btn" ?disabled=${props.operation?.status === "running"} @click=${() => props.onRequestRemovePackage(resource.label)} aria-label=${`Remove ${resource.label}`}>Remove</button>
              ` : nothing}`,
          resource.label,
        ))}` : row("No extensions", "Add a package from pi.dev above.", status("muted", "Empty")),
      )}
    </div>`;
}

function renderMemory(props: PiSurfaceProps) {
  const data = props.workspaces;
  if (!data) return unavailable(props);
  return html`${pageHeader(props, "Memory Import", "Workspace context and memory sources visible to HUI.")}
    <div class="settings-page pi-surface__body">
      <div class="callout">Read-only inventory. HUI does not copy OpenClaw memory or invent a PI memory store.</div>
      ${data.workspaces.map((workspace) => {
        const sources = data.memory.filter((source) => source.workspace === workspace);
        return section(
          workspace,
          sources.length ? `${sources.length} source${sources.length === 1 ? "" : "s"}` : "No context or memory files found.",
          sources.length ? html`${sources.map((source) => row(source.relativePath, source.kind === "context" ? "Loaded as workspace context by PI when applicable." : "Workspace memory document; not automatically imported.", `${source.bytes} B`))}` : row("Nothing to import", "The workspace remains unchanged.", status("muted", "Empty")),
        );
      })}
      ${data.diagnostics.map((note) => html`<div class="callout warning">${note}</div>`)}
    </div>`;
}

export function renderPiSurface(props: PiSurfaceProps): TemplateResult {
  switch (props.page.id) {
    case "connection": return renderConnection(props);
    case "config": return renderConfig(props);
    case "model-providers": return renderModels(props, false);
    case "model-setup": return renderModels(props, true);
    case "skills": return renderSkills(props);
    case "plugins":
    case "plugin": return renderExtensions(props, false);
    case "skill-workshop": return renderExtensions(props, true);
    case "memory-import": return renderMemory(props);
    default: return unavailable(props);
  }
}

/**
 * The pages HUI owns outright instead of reading from PI: Labs, Profile and About. Their state is HUI's own
 * settings, saved through the callback the app passes in; nothing here changes PI's configuration.
 */
import { html, type TemplateResult } from "lit";
import { renderSettingsToggle } from "./settings-toggle.ts";

import type { GatewayHealth } from "../api/control-surfaces.ts";
import type { HuiPage } from "../lib/pages.ts";
import type { Settings } from "../lib/settings/settings.ts";

export type OwnedSurfaceProps = {
  page: HuiPage;
  settings: Settings;
  health: GatewayHealth | undefined;
  onSettings: (patch: Partial<Settings>) => void;
};

const IDS = new Set(["labs", "profile", "about"]);
export function isOwnedSurface(page: HuiPage): boolean { return IDS.has(page.id); }

function header(title: string, subtitle: string) { return html`<header class="content-header content-header--settings"><div><div class="page-title">${title}</div><div class="page-subtitle">${subtitle}</div></div></header>`; }

function renderLabs(props: OwnedSurfaceProps) {
  const toggle = (key: keyof Settings["labs"], title: string, description: string) => html`
    <div class="settings-row settings-row--toggle" @click=${(event: Event) => {
      if (!(event.target as Element).closest("wa-switch")) {
        props.onSettings({ labs: { ...props.settings.labs, [key]: !props.settings.labs[key] } });
      }
    }}>
      <span class="settings-row__text"><span class="settings-row__title">${title}</span><span class="settings-row__desc">${description}</span></span>
      <span class="settings-row__control">${renderSettingsToggle(title, props.settings.labs[key], (checked) => props.onSettings({ labs: { ...props.settings.labs, [key]: checked } }))}</span>
    </div>`;
  return html`${header("Labs", "Experimental and opt-in features.")}<main class="settings-page owned-page"><p class="settings-page__intro">Labs never changes PI configuration or runtime permissions.</p><section class="settings-section"><header class="settings-section__header"><div class="settings-section__copy"><h2 class="settings-section__heading">Experiments</h2><p class="settings-section__desc">Stored locally in HUI settings and reversible at any time.</p></div></header><div class="settings-group">${toggle("denseObservability", "Dense observability", "Show more Activity and Logs rows at once.")}${toggle("detailedDebug", "Detailed debug", "Expose additional non-sensitive runtime metadata in Debug.")}</div></section></main>`;
}

function renderProfile(props: OwnedSurfaceProps) {
  const submit = (event: SubmitEvent) => { event.preventDefault(); const data = new FormData(event.currentTarget as HTMLFormElement); props.onSettings({ profileName: String(data.get("name") ?? ""), profileHandle: String(data.get("handle") ?? "") }); };
  const initials = props.settings.profileName.split(/\s+/u).map((part) => part[0]).join("").slice(0, 2).toUpperCase() || "HU";
  return html`${header("Profile", "Local presentation identity for this HUI client.")}<main class="settings-page owned-page"><section class="settings-group"><div class="profile-hero"><div class="profile-hero__avatar"><span class="identity-avatar--agent">${initials}</span></div><div class="profile-hero__name">${props.settings.profileName}</div><div class="profile-hero__handle">${props.settings.profileHandle || "No handle set"}</div></div></section><form class="settings-section" @submit=${submit}><header class="settings-section__header"><div class="settings-section__copy"><h2 class="settings-section__heading">Identity</h2><p class="settings-section__desc">Presentation only. This does not change PI or provider accounts.</p></div></header><div class="settings-group"><label class="settings-row"><span class="settings-row__text"><span class="settings-row__title">Display name</span></span><span class="settings-row__control"><input class="settings-input" name="name" maxlength="80" .value=${props.settings.profileName} /></span></label><label class="settings-row"><span class="settings-row__text"><span class="settings-row__title">Handle</span></span><span class="settings-row__control"><input class="settings-input" name="handle" maxlength="80" .value=${props.settings.profileHandle} /></span></label><div class="settings-row settings-row--actions"><div class="settings-row__control"><button class="btn primary" type="submit">Save profile</button></div></div></div></form></main>`;
}

function renderAbout(props: OwnedSurfaceProps) {
  return html`${header("About", "HUI runtime, product boundaries and diagnostic links.")}<main class="settings-page owned-page"><section class="about-hero"><img class="about-hero__clawd" src="/pi-logo-3d.png" alt="" /><h2 class="about-hero__name">HUI</h2><p class="about-hero__tagline">A local browser client that owns presentation and session registry while PI owns conversations and agent configuration.</p></section><section class="settings-section"><header class="settings-section__header"><h2 class="settings-section__heading">Runtime</h2></header><div class="settings-group">${[["Gateway", props.health?.status ?? "Unavailable"], ["Transport", props.health?.transport ?? "—"], ["Access mode", props.health?.access ?? "Full Access"], ["PI ownership", "Config and transcripts"]].map(([title, value]) => html`<div class="settings-row"><span class="settings-row__text"><span class="settings-row__title">${title}</span></span><span class="settings-row__control"><span class="settings-row__value">${value}</span></span></div>`)}</div></section><p class="settings-page__note">HUI does not copy PI transcripts, expose credential values, or add an approval layer.</p></main>`;
}

export function renderOwnedSurface(props: OwnedSurfaceProps): TemplateResult {
  switch (props.page.id) {
    case "labs": return renderLabs(props);
    case "profile": return renderProfile(props);
    case "about": return renderAbout(props);
    default: return html``;
  }
}

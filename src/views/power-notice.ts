/**
 * The banner saying the Mac stays awake with its lid closed. It only decides whether the banner shows; the gateway
 * reports the power state, and turning it off goes back through the app.
 */
import { html, nothing } from "lit";
import type { PowerStatus } from "../api/schema/power.ts";
import { icons } from "../lib/icons.ts";

/** Shown whenever the lid switch is on and the Mac is actually held awake. */
export function lidAwakeNoticeShown(power: PowerStatus | null | undefined): boolean {
  return Boolean(power?.lidOn && power.lidAwake.state === "active");
}

/** Shares the update notice's anatomy and styling. */
export function renderPowerNotice(props: {
  power: PowerStatus | null | undefined;
  dismissed: boolean;
  inert: boolean;
  onTurnOff(): void;
  onDismiss(): void;
}) {
  if (props.dismissed || !lidAwakeNoticeShown(props.power)) return nothing;
  return html`<aside class="hui-update-notice" aria-label="Sleep prevention" ?inert=${props.inert}>
    <span class="hui-update-notice__message" role="status">
      <span class="hui-update-notice__icon" aria-hidden="true">${icons.zap}</span>
      <span>This Mac won't sleep with the lid closed.</span>
    </span>
    <button class="btn hui-update-notice__review" @click=${props.onTurnOff}>Turn off</button>
    <button class="hui-update-notice__dismiss" aria-label="Dismiss sleep prevention notification"
      title="Dismiss until it turns on again" @click=${props.onDismiss}>${icons.close}</button>
  </aside>`;
}

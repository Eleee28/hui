// OpenClaw v2026.9.5 picker contract (MIT), rendered by HUI's light-DOM port.
import { html } from "lit";
import type { PickerOption } from "../lib/picker-options.ts";

export type PickerParams<Option extends PickerOption = PickerOption> = {
  id?: string;
  label: string;
  value: string | null;
  options: readonly Option[];
  disabled?: boolean;
  className?: string;
  title?: string;
  placement?: "top" | "bottom";
  searchable?: boolean;
  searchPlaceholder?: string;
  /** Offer typed text as an option; return null when the text is not a valid value. */
  customOption?: (query: string) => Option | null;
  /** Called with the typed search text, for pickers whose options come from a server. */
  onQuery?: (query: string) => void;
  showOptionTooltips?: boolean;
  showSelectedDescription?: boolean;
  onOpen?: () => void;
  onChange: (value: string) => void;
  onChangeTarget?: (value: string, select: HTMLElement) => void;
  renderLeading?: (option: Option) => unknown;
};

export function renderPicker(params: PickerParams) {
  return html`<hui-select-picker
    class=${`settings-select picker-select ${params.className ?? ""}`}
    style="width:100%;min-width:min(138px,100%)"
    .params=${params}
  ></hui-select-picker>`;
}

export function renderSettingsPicker(
  label: string,
  value: string,
  options: readonly { value: string; label: string; style?: string }[],
  onChange: (value: string) => void,
) {
  return renderPicker({ label, value, options: options.map(({ style, ...option }) => ({ ...option, labelStyle: style })), onChange });
}

/**
 * The settings pickers' option (OpenClaw v2026.9.5 picker contract, MIT) and the search filtering they share,
 * including the optional typed custom row.
 */
export type PickerOption = {
  value: string;
  label: string;
  description?: string;
  labelStyle?: string;
  disabled?: boolean;
};

/**
 * Rows shown by a picker for a search query. A picker with `customOption`
 * offers the typed text as a final row unless it already names an option.
 */
export function pickerRows<Option extends PickerOption>(
  options: readonly Option[],
  query: string,
  customOption?: (query: string) => Option | null,
): readonly Option[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/u);
  const rows = options.filter((option) => {
    const text = [option.label, option.value, option.description].join(" ").toLocaleLowerCase();
    return terms.every((term) => text.includes(term));
  });
  const typed = query.trim();
  if (!customOption || !typed) return rows;
  const exists = options.some((option) => option.value.toLocaleLowerCase() === typed.toLocaleLowerCase());
  const custom = exists ? null : customOption(typed);
  return custom ? [...rows, custom] : rows;
}

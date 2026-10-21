/**
 * Model search and launch-model resolution for the pickers. PI owns the model catalog and its default; this
 * module only matches entries and decides which available model a new session starts with.
 */
import type { RuntimeModel } from "../api/sessions.ts";

export function modelSearchText(model: RuntimeModel): string {
  return `${model.name} ${model.id} ${model.provider} ${model.provider}/${model.id}`.toLowerCase();
}

export function matchesModelSearch(text: string, query: string): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  return terms.every((term) => text.toLowerCase().includes(term));
}

/** Never silently launch PI's excluded default when a selectable model exists. */
export function resolveLaunchModel(
  models: readonly RuntimeModel[],
  selected: string,
  defaultRef: string,
): RuntimeModel | undefined {
  const find = (ref: string) => models.find((model) => `${model.provider}/${model.id}` === ref);
  return find(selected) ?? find(defaultRef) ?? models[0];
}

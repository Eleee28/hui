import assert from "node:assert/strict";
import { test } from "vitest";
import { HUI_PAGES } from "../lib/pages.ts";
import { isObservabilitySurface } from "./observability.ts";
import { isOwnedSurface } from "./hui-owned-surfaces.ts";
import { dedicatedPageRenderer, PAGE_RENDERERS } from "./pages.ts";
import { isPiSurface } from "./pi-surfaces.ts";

test("every routed page has exactly one renderer", () => {
  for (const page of HUI_PAGES) {
    const families = [dedicatedPageRenderer(page.id) !== undefined, isPiSurface(page), isObservabilitySurface(page), isOwnedSurface(page)];
    assert.equal(families.filter(Boolean).length, 1, `${page.id} must have exactly one renderer`);
  }
});

test("every dedicated renderer belongs to a routed page", () => {
  const ids = new Set(HUI_PAGES.map((page) => page.id));
  for (const id of Object.keys(PAGE_RENDERERS)) assert.ok(ids.has(id), id);
  assert.equal(dedicatedPageRenderer("toString"), undefined);
});

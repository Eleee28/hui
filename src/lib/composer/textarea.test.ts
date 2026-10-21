import assert from "node:assert/strict";
import { test, type TestContext } from "vitest";
import { adjustTextareaHeight, disconnectTextareaOverflowObserver, observeTextareaOverflow, scheduleTextareaHeightAdjustment } from "./textarea.ts";

function replaceGlobal(t: TestContext, name: string, value: unknown) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  t.onTestFinished(() => {
    if (previous) Object.defineProperty(globalThis, name, previous);
    else Reflect.deleteProperty(globalThis, name);
  });
}

class TextareaFixture extends EventTarget {
  style = { height: "", overflowY: "" };
  scrollHeight = 200;
  clientHeight = 72;
  scrollTop = 5;
  width = 100;
  compact = false;
  isConnected = true;
  attributes = new Set<string>();
  closest(selector: string) { return this.compact && selector.includes("single-line") ? this : null; }
  toggleAttribute(name: string, value: boolean) { value ? this.attributes.add(name) : this.attributes.delete(name); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  getBoundingClientRect() { return { width: this.width }; }
  element() { return this as unknown as HTMLTextAreaElement; }
}

test("textarea height obeys the owning CSS cap and short controls never fade", (t) => {
  const fixture = new TextareaFixture();
  replaceGlobal(t, "getComputedStyle", () => ({ maxHeight: "72px" }));
  adjustTextareaHeight(fixture.element());
  assert.equal(fixture.style.height, "72px");
  assert.equal(fixture.style.overflowY, "auto");
  assert.ok(fixture.attributes.has("data-scroll-fade-top"));
  fixture.clientHeight = 40;
  adjustTextareaHeight(fixture.element());
  assert.equal(fixture.attributes.size, 0);
  fixture.compact = true;
  adjustTextareaHeight(fixture.element());
  assert.deepEqual(fixture.style, { height: "", overflowY: "" });
});

test("width changes remeasure once per frame and disconnect cancels pending work", (t) => {
  const fixture = new TextareaFixture();
  let resize = () => {};
  let disconnected = false;
  const frames = new Map<number, () => void>();
  let nextFrame = 0;
  replaceGlobal(t, "getComputedStyle", () => ({ maxHeight: "150px" }));
  replaceGlobal(t, "KeyboardEvent", class extends Event {});
  replaceGlobal(t, "requestAnimationFrame", (callback: () => void) => { const id = ++nextFrame; frames.set(id, callback); return id; });
  replaceGlobal(t, "cancelAnimationFrame", (id: number) => frames.delete(id));
  replaceGlobal(t, "ResizeObserver", class {
    constructor(callback: () => void) { resize = callback; }
    observe() {}
    disconnect() { disconnected = true; }
  });
  observeTextareaOverflow(fixture.element());
  fixture.width = 200;
  fixture.scrollHeight = 44;
  resize();
  resize();
  assert.equal(frames.size, 1);
  frames.get(1)!();
  frames.delete(1);
  assert.equal(fixture.style.height, "44px");
  fixture.width = 300;
  resize();
  assert.equal(frames.size, 1);
  disconnectTextareaOverflowObserver(fixture.element());
  assert.equal(disconnected, true);
  assert.equal(frames.size, 0);
});

test("editing suppresses caret-obscuring fades until explicit navigation", (t) => {
  const fixture = new TextareaFixture();
  replaceGlobal(t, "KeyboardEvent", class extends Event {});
  observeTextareaOverflow(fixture.element());
  assert.ok(fixture.attributes.has("data-scroll-fade-bottom"));
  fixture.dispatchEvent(new Event("input"));
  assert.equal(fixture.attributes.size, 0);
  fixture.dispatchEvent(new Event("wheel"));
  assert.ok(fixture.attributes.has("data-scroll-fade-bottom"));
  disconnectTextareaOverflowObserver(fixture.element());
});

test("scheduled measurement waits for the committed value and skips detached controls", async (t) => {
  const fixture = new TextareaFixture();
  replaceGlobal(t, "getComputedStyle", () => ({ maxHeight: "none" }));
  scheduleTextareaHeightAdjustment(fixture.element());
  fixture.scrollHeight = 44;
  await Promise.resolve();
  assert.equal(fixture.style.height, "44px");
  fixture.isConnected = false;
  fixture.scrollHeight = 120;
  scheduleTextareaHeightAdjustment(fixture.element());
  await Promise.resolve();
  assert.equal(fixture.style.height, "44px");
});

import assert from "node:assert/strict";
import { test } from "vitest";
import { scrollSectionWhenReady, SECTION_SCROLL_LIMIT_MS, SECTION_SCROLL_SETTLED_MS } from "./settings-section-scroll.ts";

/** A section whose top is `offset - scroll`; scrolling it into view sets scroll = offset. */
function harness() {
  let time = 0;
  let scroll = 0;
  let offset = 636;
  let rendered = false;
  let user: (() => void) | undefined;
  const queue: (() => void)[] = [];
  const scrolls: number[] = [];
  const section = {
    getBoundingClientRect: () => ({ top: offset - scroll }),
    scrollIntoView: () => { scroll = offset; scrolls.push(offset); },
  } as unknown as Element;
  const stop = scrollSectionWhenReady({
    find: () => rendered ? section : null,
    frame: (callback) => { queue.push(callback); },
    now: () => time,
    onUserScroll: (listener) => { user = listener; return () => { user = undefined; }; },
  });
  return {
    stop, scrolls,
    render() { rendered = true; },
    grow(by: number) { offset += by; },
    userScrolls() { user?.(); },
    get listening() { return user !== undefined; },
    /** Runs frames 16 ms apart for `ms`. */
    run(ms: number) {
      for (const end = time + ms; time < end;) {
        time += 16;
        const next = queue.splice(0);
        if (!next.length) return;
        for (const callback of next) callback();
      }
    },
    get pending() { return queue.length; },
  };
}

test("waits for the section to render, then scrolls it to the top", () => {
  const h = harness();
  h.run(100);
  assert.deepEqual(h.scrolls, []);
  h.render();
  h.run(32);
  assert.deepEqual(h.scrolls, [636]);
});

test("scrolls again when a section above finishes loading and pushes it down", () => {
  const h = harness();
  h.render();
  h.run(50);
  h.grow(240);
  h.run(50);
  assert.deepEqual(h.scrolls, [636, 876]);
});

test("stops once the section stays put, and after the time limit", () => {
  const settled = harness();
  settled.render();
  settled.run(SECTION_SCROLL_SETTLED_MS + 100);
  assert.equal(settled.pending, 0);
  assert.equal(settled.listening, false);
  const never = harness();
  never.run(SECTION_SCROLL_LIMIT_MS + 100);
  assert.equal(never.pending, 0);
  assert.deepEqual(never.scrolls, []);
});

test("the operator's own scrolling ends it", () => {
  const h = harness();
  h.render();
  h.run(32);
  h.userScrolls();
  h.grow(240);
  h.run(100);
  assert.deepEqual(h.scrolls, [636]);
  assert.equal(h.pending, 0);
});

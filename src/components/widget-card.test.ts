import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

const source = readFileSync(new URL("./widget-card.ts", import.meta.url), "utf8");

test("the widget frame is sandboxed into an opaque origin and never gains HUI's", () => {
  assert.match(source, /sandbox="allow-scripts allow-forms"/u);
  assert.doesNotMatch(source, /allow-same-origin|allow-popups|allow-top-navigation|allow-modals|allow-downloads/u);
  assert.match(source, /referrerpolicy="origin"/u);
  // Only this card's own sandbox page is listened to, and only if it really is opaque.
  assert.match(source, /if \(!frame \|\| event\.source !== frame\.contentWindow\) return false;/u);
  assert.match(source, /if \(origin !== "null"\) this\.#fail\(/u);
});

test("links and full screen need a real click inside the focused widget", () => {
  assert.match(source, /document\.activeElement === frame && navigator\.userActivation\?\.isActive === true/u);
  assert.match(source, /window\.open\(url, "_blank", "noopener,noreferrer"\)/u);
  assert.match(source, /else if \(userClicked\(this\.#frame\)\) this\.#enterFullScreen\(\);/u);
});

test("full screen promotes the same card instead of moving its frame", () => {
  assert.match(source, /popover=\$\{this\.expanded \? "manual" : nothing\}/u);
  assert.match(source, /card\?\.showPopover\(\)/u);
  assert.match(source, /role=\$\{this\.expanded \? "dialog" : "group"\}/u);
  assert.match(source, /aria-modal=\$\{this\.expanded \? "true" : nothing\}/u);
});

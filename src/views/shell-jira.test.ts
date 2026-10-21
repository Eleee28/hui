/** Jira marks and action reachability in the sidebar's session rows. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

test("the session row renders the Jira mark left of the title and keeps the menu reachable", () => {
  const source = readFileSync(new URL("./shell.ts", import.meta.url), "utf8");
  assert.match(source, /\$\{showJiraLead \? renderJiraBadge\(session\) : nothing\}/);
  assert.match(source, /sidebar-recent-session__title-row">\$\{renderHoverMarquee\(session\.title/);
  assert.match(source, /installJiraHovercard\(\)/);
  assert.match(source, /value="jira:create"[\s\S]*?Create Jira work item…/);
  assert.match(source, /value="jira:link"[\s\S]*?Link Jira work item…/);
  assert.match(source, /linkedJira \? nothing : html`[\s\S]*?value="jira:create"/);
  assert.match(source, /value="copy:id"[\s\S]*?linkedJira \? html`[^`]*value="copy:jira"/);
  assert.match(source, /value="open:editor"[\s\S]*?linkedJira \? html`[^`]*value="open:jira"/);
});

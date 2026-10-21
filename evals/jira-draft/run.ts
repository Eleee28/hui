/**
 * Jira draft eval: drafts every synthetic session with a real utility model and
 * grades the result deterministically. It calls a paid model, so it is not part
 * of npm test. Run with:
 *
 *   npm run eval:jira-draft -- --model <provider/model> [--runs 3] [--case id]
 *
 * --context legacy drafts from the previous tail-only transcript slice, which
 * isolates the effect of the goal-anchored digest from the prompt.
 *
 * --thinking auto,off compares reasoning levels in one interleaved run, so a
 * slow or flaky gateway affects both arms equally. `auto` is production (the
 * cheapest level the model is actually sent); `off` is the plain request.
 */
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { JiraDraft } from "../../server/api/jira.ts";
import { draftJiraWorkItem } from "../../server/integrations/jira.ts";
import { visibleContext } from "../../server/pi/model-routing.ts";
import { runPiUtilityPrompt } from "../../server/runtimes/pi.ts";
import { sessionDigest } from "../../server/sessions/digest.ts";
import { DRAFT_CASES, type DraftCase } from "./cases.ts";
import { gradeDraft, type Grade } from "./grade.ts";


const { values } = parseArgs({
  options: {
    model: { type: "string" },
    runs: { type: "string", default: "3" },
    concurrency: { type: "string", default: "3" },
    case: { type: "string", multiple: true },
    context: { type: "string", default: "digest" },
    // Absent: production per-attempt timeouts and retry. Set to measure raw latency.
    timeout: { type: "string" },
    thinking: { type: "string", default: "auto" },
    out: { type: "string" },
  },
});
if (!values.model) {
  console.error("Pass --model <provider/model>, for example the utility model from Settings → Models.");
  process.exit(2);
}
const model = values.model;
const runs = Number(values.runs);
const concurrency = Number(values.concurrency);
const timeoutOverride = values.timeout ? Number(values.timeout) : undefined;
const contextMode = values.context === "legacy" ? "legacy" : "digest";
const thinkingModes = values.thinking.split(",").map((mode) => mode.trim()).filter(Boolean);
const selected = values.case?.length ? DRAFT_CASES.filter((item) => values.case!.includes(item.id)) : DRAFT_CASES;
if (!selected.length) {
  console.error("No case matches --case.");
  process.exit(2);
}

type Result = { case: string; run: number; thinking: string; ms: number; attempts: number; draft: JiraDraft; grade: Grade; answers?: string[] };

function draftInput(item: DraftCase): { context: string; goal?: string } {
  if (contextMode === "legacy") return { context: visibleContext(item.entries) };
  const digest = sessionDigest(item.entries);
  return { context: digest.text, ...(digest.goal ? { goal: digest.goal } : {}) };
}

async function once(item: DraftCase, run: number, thinking: string): Promise<Result> {
  const started = performance.now();
  let attempts = 0;
  const answers: string[] = [];
  const draft = await draftJiraWorkItem({
    project: item.project,
    parents: item.parents,
    title: item.title,
    cwd: tmpdir(),
    ...draftInput(item),
    model,
    run: async (options) => {
      attempts += 1;
      const answer = await runPiUtilityPrompt({ ...options, ...(timeoutOverride ? { timeoutMs: timeoutOverride } : {}), thinking });
      answers.push(answer);
      return answer;
    },
  });
  const ms = Math.round(performance.now() - started);
  const grade = gradeDraft(draft, item.expect);
  // Raw answers explain unusable drafts; keep them only for failures.
  return { case: item.id, run, thinking, ms, attempts, draft, grade, ...(grade.pass ? {} : { answers }) };
}

// Run-major, modes adjacent: both arms of an A/B see the same gateway window.
const jobs = Array.from({ length: runs }, (_, run) => selected.flatMap((item) => thinkingModes.map((mode) => () => once(item, run + 1, mode)))).flat();
const results: Result[] = [];
let next = 0;
await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
  while (next < jobs.length) {
    const job = jobs[next++]!;
    const result = await job();
    results.push(result);
    console.error((result.grade.pass ? "PASS " : "FAIL ") + result.case + " #" + result.run + (thinkingModes.length > 1 ? " [" + result.thinking + "]" : "") + " " + result.ms + "ms" + (result.attempts > 1 ? " (retried)" : "") + "  " + result.draft.summary);
  }
}));

const median = (numbers: number[]) => [...numbers].sort((a, b) => a - b)[Math.floor(numbers.length / 2)] ?? 0;
for (const mode of thinkingModes) {
  const own = results.filter((result) => result.thinking === mode);
  console.log("\nJira draft eval · " + model + " · context=" + contextMode + " · thinking=" + mode + " · " + runs + " run(s) per case\n");
  console.log("case".padEnd(34) + "pass   median   max    context");
  for (const item of selected) {
    const mine = own.filter((result) => result.case === item.id);
    const times = mine.map((result) => result.ms);
    console.log(item.id.padEnd(34) + (mine.filter((result) => result.grade.pass).length + "/" + mine.length).padEnd(7) + (median(times) / 1000).toFixed(1).padStart(5) + "s " + (Math.max(...times) / 1000).toFixed(1).padStart(6) + "s  " + draftInput(item).context.length + " chars");
  }
  const empty = own.filter((result) => !result.draft.model).length;
  const retried = own.filter((result) => result.attempts > 1);
  console.log("\nTotal " + own.filter((result) => result.grade.pass).length + "/" + own.length + " passed; " + empty + " without a model draft; " + retried.length + " retried (" + retried.filter((result) => result.draft.model).length + " recovered).");
}
for (const result of results.filter((entry) => !entry.grade.pass)) {
  console.log("\n✗ " + result.case + " #" + result.run + (thinkingModes.length > 1 ? " [" + result.thinking + "]" : "") + ": " + result.draft.summary + (result.draft.parent ? " [" + result.draft.parent + "]" : ""));
  for (const failure of result.grade.failures) console.log("  - " + failure);
}
if (results.every((result) => !result.draft.model)) {
  console.log("\nNo call produced a model draft, so these scores measure the fallback, not the prompt. Check the model and its provider quota.");
  process.exitCode = 1;
}
const out = values.out ?? join(tmpdir(), "hui-jira-draft-eval-" + contextMode + "-" + Date.now() + ".json");
await writeFile(out, JSON.stringify({ model, contextMode, thinkingModes, runs, results }, null, 2));
console.log("\nFull results: " + out);

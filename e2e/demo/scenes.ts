/** The demo clips, in overview order. Prompts match the scripted model in provider.ts. */
import type { Director, Target } from "./record.ts";

/** `providerUrl`: the scripted model's server, which also serves the demo's pages and the Datadog graph. */
export type SceneContext = { director: Director; api: (method: string, path: string, body?: unknown) => Promise<Record<string, any>>; providerUrl: string };
export type Scene = {
  name: string;
  /** The chapter tag under the window. */
  chapter: string;
  /** HUI path the clip opens on, and text that shows it is ready. */
  path?: string;
  ready?: Target;
  /** CSS size of HUI's window; smaller shows larger text. */
  viewport?: [number, number];
  /** On a phone: 390×844 in a phone frame, with touch input. */
  device?: "phone";
  /** Opens VS Code, which needs --accept-vscode-license. */
  vscode?: boolean;
  /** localStorage entries HUI loads with, such as view preferences. */
  storage?: Record<string, string>;
  /** What the narrator says, by key: `director.say(key)` speaks a line during the clip (with --voice). */
  narration?: Record<string, string>;
  /** Runs before recording starts. */
  setup?: (context: SceneContext) => Promise<void>;
  run: (context: SceneContext) => Promise<void>;
};

/** Acme's "Trial signups per minute" over the past hour, drawn the way a Datadog snapshot looks (a 1724×740 PNG, as
 * base64). It runs on the stage, whose Chrome draws the SVG; the scripted model's server then serves it as the
 * widget's graph, through the fake pup's snapshot. */
function drawSignupGraph(now: number): Promise<string> {
  const width = 1724, height = 740, left = 120, right = 1690, top = 40, bottom = 630, max = 40, minute = 60_000;
  const start = now - 60 * minute;
  // Steady trials, a dip while double submits failed, the fix's deploy, and the recovery.
  const values = Array.from({ length: 61 }, (_, i) => {
    const wave = Math.sin(i * 1.7) * 2.2 + Math.sin(i * 0.43) * 1.6;
    if (i < 18) return 26 + wave;
    if (i < 22) return 26 - (i - 17) * 4 + wave;
    if (i < 38) return 9 + wave * 0.6;
    if (i < 42) return 9 + (i - 37) * 4.5 + wave;
    return 28 + wave;
  });
  const x = (i: number) => left + (i / 60) * (right - left);
  const y = (value: number) => bottom - (value / max) * (bottom - top);
  const line = values.map((value, i) => `${x(i).toFixed(1)},${y(value).toFixed(1)}`).join(" ");
  const grid = [0, 10, 20, 30, 40].map((value) => `<line x1="${left}" x2="${right}" y1="${y(value)}" y2="${y(value)}" stroke="${value ? "#e3e6ea" : "#5c6370"}" stroke-width="${value ? 2 : 3}"/><text x="${left - 22}" y="${y(value) + 12}" text-anchor="end">${value}</text>`).join("");
  const ticks: string[] = [];
  for (let t = Math.ceil(start / (15 * minute)) * 15 * minute; t <= now; t += 15 * minute) {
    const at = x((t - start) / minute);
    const label = new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    ticks.push(`<line x1="${at}" x2="${at}" y1="${bottom}" y2="${bottom + 16}" stroke="#5c6370" stroke-width="3"/><text x="${at}" y="${bottom + 62}" text-anchor="middle">${label}</text>`);
  }
  const font = "font-family=\"-apple-system, 'Helvetica Neue', Arial, sans-serif\"";
  const deploy = x(38);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="${width}" height="${height}" fill="#fff"/>
    <g ${font} font-size="36" fill="#3c4250">${grid}${ticks.join("")}</g>
    <text ${font} font-size="30" fill="#8a909c" transform="translate(34 ${(top + bottom) / 2}) rotate(-90)" text-anchor="middle">Trials / min</text>
    <polygon points="${x(0)},${bottom} ${line} ${x(60)},${bottom}" fill="#7d4ccf" fill-opacity="0.12"/>
    <polyline points="${line}" fill="none" stroke="#7d4ccf" stroke-width="6" stroke-linejoin="round" stroke-linecap="round"/>
    <line x1="${deploy}" x2="${deploy}" y1="${top}" y2="${bottom}" stroke="#e8973d" stroke-width="4" stroke-dasharray="14 10"/>
    <text ${font} font-size="32" fill="#e8973d" x="${deploy + 16}" y="${top + 34}">deploy #482</text>
  </svg>`;
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  return image.decode().then(() => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d")!.drawImage(image, 0, 0);
    return canvas.toDataURL("image/png").split(",")[1]!;
  });
}

let pagesHook = "";
const soul = (who: string) => `# Who I am\n${who} Short answers, always with the next step.\n`;
const card = (title: string, column?: string): Target => ({ css: `${column ? `.kanban-cell--${column} ` : ""}.kanban-card__title`, text: title });
const link = (text: string): Target => ({ css: "a", text });

/** Brings a chat element to the middle of the view once it is there, as a reader scrolls to it before looking. */
async function centre(d: Director, target: Target) {
  await d.waitFor(target);
  await d.stage("window.found?.scrollIntoView({ block: 'center', behavior: 'smooth' })");
  await d.pause(800);
}

/** Sends a follow-up once the session is idle, whose composer reads "Send a message…" (a busy one names the steer and queue shortcuts). */
async function send(d: Director, prompt: string) {
  await d.click({ placeholder: "Send a message…" });
  await d.type(prompt);
  await d.pause(300);
  await d.press("Enter");
  // Sometimes the chat stops following the bottom (seen after a widget); a user would tap "Scroll to latest".
  await d.pause(600);
  if (await d.find({ css: ".chat-scroll-to-bottom[data-visible='true']" })) await d.click({ label: "Scroll to latest" });
}

export const scenes: Scene[] = [
  {
    name: "kanban",
    chapter: "Kanban",
    path: "/kanban",
    ready: { contains: "Drag a backlog item" },
    // Lanes by custom group, Storefront first, instead of long project paths.
    storage: { "hui.kanban-options": JSON.stringify({ groupBy: "custom" }) },
    narration: {
      board: "This is H U I's Kanban board. Every agent session is a card, in the stage its work is in.",
      drag: "When the work moves on, drag the card along.",
      backlog: "A backlog item starts its own session, in a fresh Git worktree, with a branch name suggested for you.",
      work: "The agent gets going right away: it reads the code, writes the change, and runs the tests.",
      stage: "Agents keep the board up to date themselves. Tell this one that CI passed, and it moves its own card to Testing.",
    },
    async run({ director: d }) {
      await d.caption("Every session is a card, in the stage its work is in");
      await d.say("board");
      await d.move(card("Apple Pay at checkout"));
      await d.pause(1_600);

      await d.caption("Drag a card when the work moves on");
      await d.say("drag");
      await d.zoom({ css: ".kanban-cell--testing", nth: 0 }, 1.35);
      await d.drag({ css: ".kanban-card", contains: "Search results skeleton" }, { css: ".kanban-cell--done", nth: 0 });
      await d.waitFor(card("Search results skeleton", "done"));
      await d.pause(700);
      await d.zoom();

      await d.caption("Start a backlog item in its own worktree");
      await d.say("backlog");
      await d.click(card("Add CSV export to the orders page"));
      await d.waitFor("New worktree");
      await d.zoom({ css: "dialog" }, 1.3);
      await d.click("New worktree");
      await d.cut(() => d.waitFor({ contains: "feature/orders-csv-export" }));
      await d.pause(1_200);
      await d.click({ css: "button", text: "Start session" });
      await d.zoom();
      await d.waitFor(card("Add CSV export to the orders page", "investigation"));
      await d.pause(800);

      await d.caption("The agent gets to work right away");
      await d.say("work");
      await d.click(card("Add CSV export to the orders page", "investigation"));
      await d.zoom({ x: 860, y: 430 }, 1.3);
      await d.waitFor({ contains: "node --test" }, 30_000);
      await d.pause(1_800);
      await d.zoom();

      await d.caption("Agents report their own stage");
      await d.say("stage");
      await d.click(link("Apple Pay at checkout"));
      await send(d, "CI passed on Apple Pay. Move it to review.");
      await d.waitFor({ contains: "moved this card to" }, 30_000);
      await d.pause(800);
      await d.click(link("Kanban"));
      await d.waitFor(card("Apple Pay at checkout", "testing"));
      await d.zoom(card("Apple Pay at checkout", "testing"), 1.4);
      await d.pause(2_000);
      await d.zoom();
      await d.caption();
    },
  },
  {
    name: "integrations",
    chapter: "Rich chat",
    viewport: [1280, 720],
    ready: "Apple Pay at checkout",
    narration: {
      chart: "Answers don't have to be walls of text. Ask for a chart of this week's builds,",
      widget: "and the agent draws an interactive widget, right in the chat, on your theme.",
      browser: "It can drive a real browser too. You watch the page live while it fills in the signup form.",
      cards: "Links unfurl into cards, like the merged pull request and the Slack thread behind it.",
      datadog: "Datadog dashboards too: the widget's graph, read through your own orgs, as in Slack.",
    },
    // The widget's graph: drawn on the stage, then served by the scripted model's server as the fake pup's snapshot.
    async setup({ director, providerUrl }) {
      const png = await director.stage<string>(`(${drawSignupGraph.toString()})(${Date.now()})`);
      const response = await fetch(new URL("/demo/datadog-graph.png", providerUrl), { method: "PUT", body: Buffer.from(png, "base64") });
      if (!response.ok) throw new Error(`The Datadog graph upload failed: ${response.status}`);
    },
    async run({ director: d }) {
      await d.caption("Ask for a chart");
      await d.say("chart");
      await d.click({ label: "New session in STOREFRONT" });
      await d.click({ placeholder: "What should this session work on?" });
      await d.type("Chart this week's build times from ci/build-times.csv");
      await d.press("Enter");
      await d.caption("…and get an interactive widget, on your theme");
      await d.say("widget");
      await d.waitFor({ contains: "Toggle the series" }, 30_000);
      await d.zoom({ css: ".hui-widget-card__frame" }, 1.3);
      // The widget runs in its own sandboxed frame; its toggle sits at the top left.
      const widget = await d.waitFor({ css: ".hui-widget-card__frame" });
      await d.click({ x: widget.x + 130, y: widget.y + 24 });
      await d.pause(1_600);
      await d.click({ x: widget.x + 40, y: widget.y + 24 });
      await d.pause(900);
      await d.zoom();

      await d.caption("It drives a real browser, live in the chat");
      await d.say("browser");
      await send(d, "Check that signup still works on staging");
      await d.waitFor({ css: ".hui-browser-preview" }, 30_000);
      await d.zoom({ css: ".hui-browser-preview" }, 1.35);
      // The page's own confirmation, which the script quotes only when the browser really got there.
      await d.waitFor({ contains: "We sent a link to dana@acme.dev" }, 40_000);
      await d.pause(600);
      await d.zoom();
      await d.caption("Links unfurl into cards");
      await d.say("cards");
      await centre(d, { css: ".github-embed" });
      await d.zoom({ css: ".github-embed" }, 1.35);
      await d.pause(2_200);
      await d.zoom();
      await d.caption("Datadog graphs, from your orgs");
      await d.say("datadog");
      // The card lands under the others, once its graph has loaded.
      await centre(d, { css: ".datadog-embed__image" });
      await d.zoom({ css: ".datadog-embed" }, 1.3);
      await d.pause(2_600);
      await d.zoom();
      await d.caption();
    },
  },
  {
    name: "workpane",
    chapter: "Terminal, diff and VS Code",
    path: "/sessions/demo-10",
    ready: { contains: "Format them as currency" },
    vscode: true,
    narration: {
      terminal: "Every conversation has a Work pane beside it. Open a terminal, already in the project's folder.",
      agent: "The agent can use the same terminal. You watch it run the tests, live.",
      diff: "The Diff view shows exactly what changed, file by file.",
      files: "Click a file to open it in the Files view,",
      vscode: "or open the whole project in V S Code, without leaving the browser.",
    },
    async run({ director: d }) {
      await d.caption("Every conversation has a Work pane");
      await d.say("terminal");
      await d.click({ label: "Open terminal" });
      await d.waitFor({ contains: "Shared · Connected" });
      const terminal = await d.waitFor({ css: ".hui-terminal-surface" });
      // The prompt and output sit at the top of the terminal.
      const output = { x: terminal.x + terminal.width / 2, y: terminal.y + 150 };
      await d.zoom(output, 1.5);
      await d.click({ x: terminal.x + 120, y: terminal.y + 40 });
      await d.type("git status --short && git log --oneline -1", { terminal: true });
      await d.press("Enter");
      await d.pause(1_400);
      await d.zoom();

      await d.caption("The agent can type in your terminal too");
      await d.say("agent");
      await send(d, "Go ahead, and run the tests in my terminal");
      await d.zoom(output, 1.5);
      await d.waitFor({ contains: "3 tests pass in your terminal" }, 40_000);
      await d.pause(1_200);
      await d.zoom();

      await d.caption("Every change, in the Diff view");
      await d.say("diff");
      await d.click({ label: "Maximize Work pane" });
      await d.click({ label: "Open Work view" });
      await d.click({ css: ".work-pane__menu-item[value='launch:diff']" });
      await d.click({ css: ".hui-diff-file[data-path='src/orders/orders-page.js']" });
      await d.click({ css: ".hui-diff-segmented__option", text: "Side by side" });
      await d.waitFor({ contains: "formatTotal(order.total" });
      await d.zoom({ css: ".hui-diff-main" }, 1.4);
      await d.pause(2_200);
      await d.zoom();

      await d.caption("Open a file in Files");
      await d.say("files");
      await d.click({ css: ".hui-diff-main__open" });
      await d.waitFor({ css: ".hui-files-editor" });
      await d.pause(1_800);

      await d.caption("…or the whole project in VS Code");
      await d.say("vscode");
      await d.click({ label: "Open Work view" });
      await d.click({ css: ".work-pane__menu-item[value='launch:vscode']" });
      // VS Code's server starts (and downloads its build the first time); the clip skips the wait.
      await d.cut(() => d.waitFor({ css: "[aria-label^='Source Control']" }, 300_000));
      await d.pause(800);
      await d.click({ css: "[aria-label^='Source Control']" });
      await d.click({ css: ".monaco-list-row", contains: "orders-page.js" });
      await d.pause(1_000);
      await d.zoom({ css: ".monaco-workbench" }, 1.3);
      await d.pause(2_400);
      await d.zoom();
      await d.caption();
    },
  },
  {
    name: "subagents",
    chapter: "Subagents and watchers",
    viewport: [1280, 720],
    ready: "Apple Pay at checkout",
    narration: {
      ask: "Big jobs can be split up. Here, one code review becomes three, running in parallel.",
      children: "One card tracks every helper while the agent waits for all of them.",
      report: "When they're done, the agent sums up what they found.",
      open: "You can open any of them to see exactly what it did.",
      parent: "Its task shows the session that sent it. Click the name to go back.",
      watcher: "For things that take a while, like CI, the agent leaves a watcher behind. It waits in the background, and merges once the checks go green.",
    },
    async run({ director: d }) {
      await d.caption("Ask for a review that splits three ways");
      await d.say("ask");
      await d.click({ label: "New session in PAYMENTS" });
      await d.click({ placeholder: "What should this session work on?" });
      await d.type("Review PR #142 before we merge: security, performance and test coverage, in parallel");
      await d.press("Enter");
      await d.caption("One card tracks every helper");
      await d.say("children");
      await d.waitFor({ css: ".chat-swarm" }, 30_000);
      await d.zoom({ css: ".chat-swarm" }, 1.6);
      await d.pause(2_400);
      await d.zoom();
      await d.caption("…and the agent sums them up");
      await d.say("report");
      await d.waitFor({ contains: "All three reviews are in" }, 40_000);
      await d.pause(2_200);
      await d.caption("Open any helper to see its work");
      await d.say("open");
      await d.click({ css: ".chat-swarm__summary" });
      await d.click({ css: ".chat-subagents__row", contains: "Security review" });
      await d.waitFor({ contains: "1 blocking issue" });
      await d.zoom({ contains: "1 blocking issue" }, 1.4);
      await d.pause(2_200);
      await d.zoom();
      await d.caption("Its task names the session that sent it");
      await d.say("parent");
      await d.zoom({ css: ".chat-group--peer" }, 1.5);
      await d.pause(2_000);
      await d.zoom();
      await d.click({ css: ".chat-sender-link", text: "Review PR #142 in parallel" });
      await d.caption("Watchers wait on CI for you");
      await d.say("watcher");
      await send(d, "Fix the ownership check, then merge once CI is green");
      await d.waitFor({ css: ".chat-watcher" }, 30_000);
      await d.zoom({ css: ".chat-watcher" }, 1.4);
      await d.pause(1_500);
      // HUI checks on watchers every 10 s; skip to the moment CI is green.
      await d.cut(() => d.waitFor({ contains: "CI green, merged #142" }, 30_000));
      await d.pause(1_200);
      await d.click({ css: ".chat-watcher" });
      await d.waitFor({ css: ".chat-watcher__log" });
      await d.pause(2_200);
      await d.zoom();
      await d.caption();
    },
  },
  {
    name: "bots",
    chapter: "Bots",
    viewport: [1280, 720],
    ready: "Apple Pay at checkout",
    async setup({ api }) {
      const { bot } = await api("POST", "/__hui/bots", { name: "Scout", title: "Release captain", avatar: { shape: "blob", color: "#5b8cff" }, soul: soul("Scout, the team's release captain.") });
      await api("POST", "/__hui/bots", { name: "Pixel", title: "Design reviewer", avatar: { shape: "heart", color: "#ff7a6b", ears: "cat" }, soul: soul("Pixel, who reviews UI changes.") });
      await api("POST", "/__hui/bots", { name: "Owl", title: "On-call SRE", avatar: { emoji: "🦉" }, soul: soul("Owl, the on-call SRE who watches the pager overnight.") });
      await api("POST", `/__hui/bots/${bot.id}/messages`, { text: "Heads-up: refunds roll out to 10% of stores on Monday, and Priya owns the rollback.", wait: true });
    },
    narration: {
      roster: "Bots are agents that stay. Each one has a face, a single long-running chat, and a memory.",
      routine: "They schedule their own routines. Ask Scout for a weekday digest, and it sets one up.",
      run: "Run it now, and the digest already knows what you told it earlier.",
      panel: "Its panel shows what it does on its own, and expands when you need the room.",
      handoff: "Agents hand a bot work by tagging it. You see what they sent, next to the bot's face.",
      reply: "Scout answers right in the agent's chat, under its own face.",
      follow: "Click a name to open that chat.",
    },
    async run({ director: d }) {
      await d.caption("Bots are agents that stay: a face, one chat and a memory");
      await d.say("roster");
      await d.click({ css: "#sidebar-tab-bots" });
      await d.waitFor("Owl");
      await d.zoom({ css: ".bot-roster" }, 1.8);
      await d.pause(1_800);
      await d.zoom();
      await d.click({ css: ".bot-row__name", text: "Scout" });
      await d.caption("They schedule their own routines");
      await d.say("routine");
      await send(d, "Every weekday at 9, post a digest of open PRs and today's rollouts");
      await d.waitFor({ contains: "runs every weekday at 9:00" }, 30_000);
      await d.pause(1_000);
      await d.caption("Run one now, and it remembers what you told it");
      await d.say("run");
      await d.click({ css: ".bot-overview__name", text: "Morning digest" });
      await d.click({ label: "Run now: Morning digest" });
      await d.waitFor({ contains: "Nothing is blocked" }, 30_000);
      await d.zoom({ contains: "Priya owns the rollback" , last: true }, 1.4);
      await d.pause(2_200);
      await d.zoom();
      await d.caption("Its panel shows what it does, and expands");
      await d.say("panel");
      await d.click({ label: "Back to Scout" });
      await d.click({ label: "Expand the panel" });
      await d.pause(800);
      await d.zoom({ css: ".bot-overview" }, 1.3);
      await d.pause(2_400);
      await d.zoom();
      await d.click({ label: "Show the chat beside the panel" });
      await d.caption("Agents hand bots work with an @");
      await d.say("handoff");
      await d.click({ css: "#sidebar-tab-sessions" });
      await d.click({ css: "a", contains: "Apple Pay at checkout" });
      await d.waitFor({ contains: "merchant validation endpoint next" });
      await send(d, "@scout make sure Apple Pay is on Monday's rollout");
      await d.waitFor({ css: ".chat-handoff" }, 30_000);
      await d.zoom({ css: ".chat-handoff" }, 1.6);
      await d.pause(1_800);
      await d.zoom();
      await d.caption("Scout answers in the agent's chat");
      await d.say("reply");
      await d.waitFor({ css: ".chat-group--peer" }, 30_000);
      await d.zoom({ css: ".chat-group--peer" }, 1.5);
      await d.pause(2_200);
      await d.zoom();
      await d.caption("Click a name to open that chat");
      await d.say("follow");
      await d.click({ css: ".chat-sender-link", text: "Scout" });
      await d.waitFor({ css: ".chat-sender-link", text: "Apple Pay at checkout" }, 15_000);
      await d.zoom({ css: ".chat-group--peer", contains: "Monday" }, 1.4);
      await d.pause(2_200);
      await d.zoom();
      await d.caption();
    },
  },
  {
    name: "teamwork",
    chapter: "Bots working together",
    viewport: [1280, 720],
    ready: "Apple Pay at checkout",
    async setup({ api }) {
      await api("POST", "/__hui/bots", { name: "Piper", title: "PR shepherd", avatar: { shape: "blob", color: "#34c38f" }, soul: soul("Piper, who watches pull requests until they merge.") });
      const { bot: owl } = await api("POST", "/__hui/bots", { name: "Owl", title: "On-call SRE", avatar: { emoji: "🦉" }, soul: soul("Owl, the on-call SRE for payments.") });
      await api("POST", "/__hui/bots", { name: "Pixel", title: "Design reviewer", avatar: { shape: "heart", color: "#ff7a6b", ears: "cat" }, soul: soul("Pixel, who reviews UI changes.") });
      const { hook } = await api("POST", `/__hui/bots/${owl.id}/triggers`, {
        name: "Pages", source: "listener", filter: { match: { field: "fields.channel", op: "equals", value: "payments-oncall" } },
        prompt: "Investigate this page. Hand any code fix to @piper.", cooldownSeconds: 0,
      });
      pagesHook = hook.path;
      await api("POST", pagesHook, { events: [] });
    },
    narration: {
      team: "Bots don't work alone. They take work from agents, and from each other.",
      handoff: "When an agent opens a pull request, it hands it to Piper, the P R shepherd.",
      question: "Piper watches C I, and brings the reviewer's question back to the agent that wrote the code.",
      answer: "The agent makes the call, and Piper takes it from there.",
      trigger: "Triggers wake a bot when something happens elsewhere. Here, a small listener watches the on-call channel for Owl.",
      page: "A page comes in, and Owl starts digging right away.",
      bots: "Owl finds the bad deploy, and tags Piper to revert it. Bots hand work to each other, too.",
      reverted: "Piper reverts it, and reports back to Owl.",
      follow: "Click a name to see the other side of the conversation.",
    },
    async run({ director: d, api }) {
      await d.caption("Bots work with agents, and with each other");
      await d.say("team");
      await d.click({ css: "#sidebar-tab-bots" });
      await d.waitFor({ css: ".bot-row__name", text: "Pixel" });
      await d.zoom({ css: ".bot-roster" }, 1.8);
      await d.pause(1_800);
      await d.zoom();
      await d.click({ css: "#sidebar-tab-sessions" });
      await d.click({ css: "a", contains: "Retry-safe webhooks" });
      await d.waitFor({ contains: "Tests cover duplicates" });

      await d.caption("An agent hands its PR to Piper");
      await d.say("handoff");
      await send(d, "Open the PR, and ask @piper to watch it until it merges");
      await d.waitFor({ css: ".chat-handoff" }, 30_000);
      await centre(d, { css: ".chat-handoff" });
      await d.zoom({ css: ".chat-handoff" }, 1.6);
      await d.pause(1_800);
      await d.zoom();

      await d.caption("Piper brings the reviewer's question back");
      await d.say("question");
      await d.waitFor({ css: ".chat-group--peer", contains: "Lee asks" }, 30_000);
      await centre(d, { css: ".chat-group--peer", contains: "Lee asks" });
      await d.zoom({ css: ".chat-group--peer", contains: "Lee asks" }, 1.5);
      await d.pause(2_200);
      await d.zoom();

      await d.caption("The agent decides, and answers");
      await d.say("answer");
      await d.waitFor({ contains: "Answered Lee through Piper" }, 30_000);
      await centre(d, { css: ".chat-handoff", last: true });
      await d.zoom({ css: ".chat-handoff", last: true }, 1.5);
      await d.pause(1_800);
      await d.zoom();

      await d.caption("Triggers wake a bot");
      await d.say("trigger");
      await d.click({ css: "#sidebar-tab-bots" });
      await d.click({ css: ".bot-row__name", text: "Owl" });
      await d.waitFor({ css: "section[aria-labelledby$='overview-triggers']", contains: "Pages" });
      await d.zoom({ css: "section[aria-labelledby$='overview-triggers']" }, 1.6);
      await d.pause(1_800);
      await d.zoom();

      await d.caption("A page wakes Owl");
      await d.say("page");
      await api("POST", pagesHook, { events: [{
        id: "page-4821", summary: "High error rate on POST /refunds", fields: { channel: "payments-oncall" },
        details: "payments-api: 12% of POST /refunds requests failed in the last 5 minutes (normally 0.1%). Started 14:02.",
      }] });
      await d.waitFor({ contains: "Investigate this page" }, 15_000);
      await d.zoom({ contains: "Investigate this page" }, 1.4);
      await d.pause(1_800);
      await d.zoom();

      await d.caption("Owl hands the revert to Piper");
      await d.say("bots");
      await d.waitFor({ css: ".chat-handoff" }, 30_000);
      await centre(d, { css: ".chat-handoff" });
      await d.zoom({ css: ".chat-handoff" }, 1.6);
      await d.pause(1_800);
      await d.zoom();

      await d.caption("Piper reverts it, and reports back");
      await d.say("reverted");
      await d.waitFor({ css: ".chat-group--peer", contains: "Reverted" }, 30_000);
      await centre(d, { css: ".chat-group--peer", contains: "Reverted" });
      await d.zoom({ css: ".chat-group--peer", contains: "Reverted" }, 1.5);
      await d.pause(1_800);
      await d.zoom();
      await d.waitFor({ contains: "Closing the page" }, 30_000);

      await d.caption("Click a name to open that chat");
      await d.say("follow");
      await d.click({ css: ".chat-sender-link", text: "Piper" });
      await d.waitFor({ css: ".chat-group--peer", contains: "Please revert" }, 15_000);
      await centre(d, { css: ".chat-group--peer", contains: "Please revert" });
      await d.zoom({ css: ".chat-group--peer", contains: "Please revert" }, 1.4);
      await d.pause(2_200);
      await d.zoom();
      await d.caption();
    },
  },
  {
    name: "phone",
    chapter: "On your phone",
    device: "phone",
    path: "/sessions/demo-1",
    ready: { contains: "Add Apple Pay to checkout" },
    storage: { "hui.kanban-options": JSON.stringify({ groupBy: "custom" }) },
    narration: {
      phone: "And it all works on your phone. Reach your laptop over Tailscale, and your sessions are right there.",
      ask: "Check in on an agent from anywhere,",
      board: "or keep an eye on the whole board, wherever you are.",
    },
    async run({ director: d }) {
      await d.caption("HUI works on your phone too");
      await d.say("phone");
      await d.pause(2_000);
      await d.caption("Check in from anywhere");
      await d.say("ask");
      await d.click({ placeholder: "Send a message…" });
      await d.type("Quick status on Apple Pay?");
      // On a touch screen Return adds a line; the send button sends.
      await d.click({ label: "Send message" });
      await d.waitFor({ contains: "Want me to open the pull request?" }, 30_000);
      await d.zoom({ contains: "Want me to open the pull request?" }, 1.35);
      await d.pause(1_600);
      await d.zoom();
      await d.caption("The board fits in your pocket");
      await d.say("board");
      await d.click({ label: "Open navigation" });
      await d.pause(900);
      await d.click(link("Kanban"));
      await d.waitFor({ contains: "Drag a backlog item" });
      await d.pause(800);
      // Each lane scrolls sideways through the stages.
      await d.swipe({ css: ".kanban-cell--backlog", nth: 0 }, 260);
      await d.pause(900);
      await d.swipe({ css: ".kanban-cell--investigation", nth: 0 }, 300);
      await d.waitFor(card("Apple Pay at checkout"));
      await d.pause(1_800);
      await d.caption();
    },
  },
];

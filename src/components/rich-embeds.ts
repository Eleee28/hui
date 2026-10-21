/**
 * Custom elements for the rich blocks rendered markdown can contain: Mermaid diagrams, KaTeX math, Vega-Lite charts,
 * Slack link cards and X posts. Markdown only emits the tags; importing this module registers them. Heavy renderers
 * load on first use, follow the current theme, and a failed render shows its error in place of the block.
 */
import { parseSafeChartSpec } from "../lib/markdown/chart-spec.ts";
import { openMediaViewer } from "./media-viewer.ts";

type TwitterWidgets = {
  createTweet: (
    id: string,
    target: HTMLElement,
    options: { align: "left"; dnt: true; theme: "dark" | "light" },
  ) => Promise<HTMLElement | undefined>;
};

export {};

declare global {
  interface Window {
    twttr?: { widgets?: TwitterWidgets };
  }
}

let mermaidSequence = 0;
let mermaidQueue: Promise<void> = Promise.resolve();
let twitterScript: Promise<TwitterWidgets> | undefined;

function prefersDark(): boolean {
  const mode = document.documentElement.dataset["themeMode"];
  return mode === "dark" || (mode === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
}

function renderMermaid(code: string, target: HTMLElement): Promise<void> {
  const task = mermaidQueue.catch(() => undefined).then(async () => {
    const { default: mermaid } = await import("mermaid");
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme: prefersDark() ? "dark" : "default",
    });
    const { svg, bindFunctions } = await mermaid.render(`hui-mermaid-${++mermaidSequence}`, code, target);
    target.innerHTML = svg;
    bindFunctions?.(target);
  });
  mermaidQueue = task;
  return task;
}

async function renderMath(source: string, target: HTMLElement, displayMode: boolean): Promise<void> {
  const { default: katex } = await import("katex");
  target.innerHTML = katex.renderToString(source, {
    displayMode,
    output: "htmlAndMathml",
    strict: "warn",
    throwOnError: true,
    trust: false,
  });
}

async function renderVegaChart(source: string, target: HTMLElement): Promise<() => void> {
  const parsed = parseSafeChartSpec(source);
  const [{ compile }, { View, parse }] = await Promise.all([import("vega-lite"), import("vega")]);
  const style = getComputedStyle(document.documentElement);
  const foreground = style.getPropertyValue("--text").trim() || (prefersDark() ? "#f5f5f5" : "#202020");
  const muted = style.getPropertyValue("--muted").trim() || (prefersDark() ? "#a0a0a0" : "#666666");
  const border = style.getPropertyValue("--border").trim() || (prefersDark() ? "#343434" : "#dddddd");
  const spec = structuredClone(parsed);
  if (spec["width"] === undefined || spec["width"] === "container") spec["width"] = Math.max(240, Math.min(640, target.clientWidth - 32));
  if (spec["height"] === undefined) spec["height"] = 280;
  spec["background"] ??= "transparent";
  spec["config"] = {
    axis: { gridColor: border, labelColor: muted, titleColor: foreground },
    legend: { labelColor: muted, titleColor: foreground },
    title: { color: foreground },
    ...((spec["config"] && typeof spec["config"] === "object") ? spec["config"] : {}),
  };
  const compiled = compile(spec as unknown as Parameters<typeof compile>[0]).spec;
  target.replaceChildren();
  const view = new View(parse(compiled), { container: target, hover: false, renderer: "svg" });
  await view.runAsync();
  return () => view.finalize();
}

function loadTwitterWidgets(): Promise<TwitterWidgets> {
  const existing = window.twttr?.widgets;
  if (existing) return Promise.resolve(existing);
  if (twitterScript) return twitterScript;
  twitterScript = new Promise<TwitterWidgets>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://platform.twitter.com/widgets.js";
    script.async = true;
    script.dataset["huiTwitterWidgets"] = "true";
    script.addEventListener("load", () => {
      const widgets = window.twttr?.widgets;
      if (widgets) resolve(widgets);
      else reject(new Error("X embed API did not initialize."));
    }, { once: true });
    script.addEventListener("error", () => reject(new Error("X embed script could not be loaded.")), { once: true });
    document.head.append(script);
  }).catch((error) => {
    twitterScript = undefined;
    throw error;
  });
  return twitterScript;
}

const EXPAND_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>';

interface DiagramViewerOptions {
  label: string;
  name: string;
  source: string;
}

/**
 * Makes a rendered diagram open in the media viewer: an explicit expand
 * control, a click anywhere on the drawing, or Enter/Space on the focused
 * embed. Text selection inside the diagram never opens it.
 */
function enableDiagramViewer(host: HTMLElement, options: DiagramViewerOptions): void {
  const open = () => {
    const svg = host.querySelector<SVGSVGElement>(":scope > svg");
    if (svg) openMediaViewer({ kind: "diagram", svg, label: options.label, name: options.name, source: options.source }, host);
  };
  const tools = document.createElement("div");
  tools.className = "markdown-rich-embed__tools";
  const expand = document.createElement("button");
  expand.type = "button";
  expand.className = "markdown-rich-embed__expand";
  expand.setAttribute("aria-label", `Open ${options.label.toLowerCase()} viewer`);
  expand.title = "Open viewer";
  expand.innerHTML = EXPAND_ICON;
  expand.addEventListener("click", (event) => {
    event.stopPropagation();
    open();
  });
  tools.append(expand);
  host.prepend(tools);
  host.dataset["viewable"] = "";
  host.onclick = (event) => {
    const selection = document.getSelection();
    if (selection && !selection.isCollapsed && host.contains(selection.anchorNode)) return;
    if (event.target instanceof Element && event.target.closest("a, button")) return;
    open();
  };
  host.onkeydown = (event) => {
    if (event.target !== host || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    open();
  };
}

function disableDiagramViewer(host: HTMLElement): void {
  delete host.dataset["viewable"];
  host.onclick = null;
  host.onkeydown = null;
}

class HuiMermaidElement extends HTMLElement {
  #source: string | undefined;
  #timer: number | undefined;
  #renderVersion = 0;

  connectedCallback(): void {
    const source = this.#source ??= this.querySelector("template")?.content.textContent ?? "";
    disableDiagramViewer(this);
    this.replaceChildren();
    const status = document.createElement("span");
    status.className = "markdown-rich-embed__status";
    status.textContent = "Rendering diagram…";
    status.setAttribute("role", "status");
    this.append(status);
    const version = ++this.#renderVersion;
    this.#timer = window.setTimeout(() => {
      this.#timer = undefined;
      void renderMermaid(source, this).then(() => {
        if (this.isConnected && version === this.#renderVersion) enableDiagramViewer(this, { label: "Mermaid diagram", name: "mermaid-diagram", source });
      }, (error: unknown) => {
        if (!this.isConnected || version !== this.#renderVersion) return;
        this.replaceChildren();
        const failure = document.createElement("span");
        failure.className = "markdown-rich-embed__error";
        failure.setAttribute("role", "alert");
        failure.textContent = error instanceof Error ? `Diagram could not be rendered: ${error.message}` : "Diagram could not be rendered.";
        this.append(failure);
      });
    }, 180);
  }

  disconnectedCallback(): void {
    this.#renderVersion += 1;
    if (this.#timer !== undefined) window.clearTimeout(this.#timer);
  }
}

class HuiMathElement extends HTMLElement {
  #source: string | undefined;
  #renderVersion = 0;

  connectedCallback(): void {
    const source = this.#source ??= this.querySelector("template")?.content.textContent ?? "";
    this.replaceChildren();
    const version = ++this.#renderVersion;
    void renderMath(source, this, this.dataset["display"] === "block").catch((error: unknown) => {
      if (!this.isConnected || version !== this.#renderVersion) return;
      this.replaceChildren();
      const failure = document.createElement(this.dataset["display"] === "block" ? "span" : "code");
      failure.className = "markdown-rich-embed__error";
      failure.setAttribute("role", "alert");
      failure.textContent = error instanceof Error ? `Math could not be rendered: ${error.message}` : "Math could not be rendered.";
      this.append(failure);
    });
  }

  disconnectedCallback(): void {
    this.#renderVersion += 1;
  }
}

class HuiVegaChartElement extends HTMLElement {
  #source: string | undefined;
  #timer: number | undefined;
  #renderVersion = 0;
  #finalize: (() => void) | undefined;

  connectedCallback(): void {
    const source = this.#source ??= this.querySelector("template")?.content.textContent ?? "";
    this.#finalize?.();
    this.#finalize = undefined;
    disableDiagramViewer(this);
    this.replaceChildren();
    const status = document.createElement("span");
    status.className = "markdown-rich-embed__status";
    status.textContent = "Rendering chart…";
    status.setAttribute("role", "status");
    this.append(status);
    const version = ++this.#renderVersion;
    this.#timer = window.setTimeout(() => {
      this.#timer = undefined;
      void renderVegaChart(source, this).then((finalize) => {
        if (!this.isConnected || version !== this.#renderVersion) {
          finalize();
          return;
        }
        this.#finalize = finalize;
        enableDiagramViewer(this, { label: "Chart", name: "chart", source });
      }).catch((error: unknown) => {
        if (!this.isConnected || version !== this.#renderVersion) return;
        this.replaceChildren();
        const failure = document.createElement("span");
        failure.className = "markdown-rich-embed__error";
        failure.setAttribute("role", "alert");
        failure.textContent = error instanceof Error ? `Chart could not be rendered: ${error.message}` : "Chart could not be rendered.";
        this.append(failure);
      });
    }, 180);
  }

  disconnectedCallback(): void {
    this.#renderVersion += 1;
    if (this.#timer !== undefined) window.clearTimeout(this.#timer);
    this.#finalize?.();
    this.#finalize = undefined;
  }
}

class HuiSlackLinkElement extends HTMLElement {
  connectedCallback(): void {
    if (this.childElementCount > 0) return;
    const url = this.dataset["url"] ?? "https://slack.com";
    const workspace = this.dataset["workspace"] ?? "Slack";
    const channelId = this.dataset["channelId"] ?? "";
    const kind = this.dataset["kind"] === "message" ? "message" : "channel";
    this.classList.add("markdown-slack-link");
    this.setAttribute("role", "article");
    this.setAttribute("aria-label", `Slack ${kind}`);

    const identity = document.createElement("div");
    identity.className = "markdown-slack-link__identity";
    const mark = document.createElement("span");
    mark.className = "markdown-slack-link__mark";
    mark.setAttribute("aria-hidden", "true");
    for (const color of ["cyan", "green", "yellow", "red"]) {
      const segment = document.createElement("span");
      segment.dataset["color"] = color;
      mark.append(segment);
    }
    const copy = document.createElement("span");
    copy.className = "markdown-slack-link__copy";
    const title = document.createElement("strong");
    title.textContent = kind === "message" ? "Slack message" : "Slack channel";
    const detail = document.createElement("span");
    const workspaceLabel = /^[A-Z][A-Z0-9]{7,}$/iu.test(workspace) ? `Workspace ${workspace}` : workspace;
    detail.textContent = channelId ? `${workspaceLabel} · ${channelId}` : workspaceLabel;
    copy.append(title, detail);
    identity.append(mark, copy);

    const open = document.createElement("a");
    open.href = url;
    open.target = "_blank";
    open.rel = "noreferrer noopener";
    open.textContent = "Open in Slack";
    this.append(identity, open);
  }
}

class HuiTweetEmbedElement extends HTMLElement {
  connectedCallback(): void {
    if (this.childElementCount > 0) return;
    const url = this.dataset["url"] ?? "https://x.com";
    const tweetId = this.dataset["tweetId"] ?? "";
    this.classList.add("markdown-tweet-embed");

    const facade = document.createElement("div");
    facade.className = "markdown-tweet-embed__facade";
    const copy = document.createElement("div");
    copy.className = "markdown-tweet-embed__copy";
    const label = document.createElement("strong");
    label.textContent = "Post on X";
    const detail = document.createElement("span");
    detail.textContent = "Loading contacts X and may share your IP address and browser data.";
    copy.append(label, detail);

    const actions = document.createElement("div");
    actions.className = "markdown-tweet-embed__actions";
    const open = document.createElement("a");
    open.href = url;
    open.target = "_blank";
    open.rel = "noreferrer noopener";
    open.textContent = "Open on X";
    const load = document.createElement("button");
    load.type = "button";
    load.textContent = "Load post";
    load.addEventListener("click", () => void this.#load(tweetId, url, load));
    actions.append(open, load);
    facade.append(copy, actions);
    this.append(facade);
  }

  async #load(tweetId: string, url: string, button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    button.textContent = "Loading…";
    const mount = document.createElement("div");
    mount.className = "markdown-tweet-embed__mount";
    this.replaceChildren(mount);
    try {
      const widgets = await loadTwitterWidgets();
      const rendered = await widgets.createTweet(tweetId, mount, {
        align: "left",
        dnt: true,
        theme: prefersDark() ? "dark" : "light",
      });
      if (!rendered) throw new Error("This post is unavailable or cannot be embedded.");
    } catch (error) {
      this.replaceChildren();
      const failure = document.createElement("div");
      failure.className = "markdown-rich-embed__error";
      failure.setAttribute("role", "alert");
      failure.textContent = error instanceof Error ? error.message : "Post could not be loaded.";
      const fallback = document.createElement("a");
      fallback.href = url;
      fallback.target = "_blank";
      fallback.rel = "noreferrer noopener";
      fallback.textContent = "Open on X";
      this.append(failure, fallback);
    }
  }
}

if (!customElements.get("hui-mermaid")) customElements.define("hui-mermaid", HuiMermaidElement);
if (!customElements.get("hui-math")) customElements.define("hui-math", HuiMathElement);
if (!customElements.get("hui-vega-chart")) customElements.define("hui-vega-chart", HuiVegaChartElement);
if (!customElements.get("hui-slack-link")) customElements.define("hui-slack-link", HuiSlackLinkElement);
if (!customElements.get("hui-tweet-embed")) customElements.define("hui-tweet-embed", HuiTweetEmbedElement);

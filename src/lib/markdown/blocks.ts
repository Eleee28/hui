/** Interactive-code subset of OpenClaw 2026.9.5 markdown-blocks.ts and
 * markdown-code-blocks.ts. Source ec9c1a13; see THIRD_PARTY_NOTICES.md.
 * Static tables are rendered by markdown.ts; rich embeds are isolated custom
 * elements rather than part of this code-block behavior. */
import { nothing } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import { directive, type ElementPart } from "lit/directive.js";

export function updateCodeBlockWidthOverflow(wrapper: HTMLElement): void {
  const viewport = wrapper.querySelector<HTMLElement>(".code-block-viewport");
  const code = viewport?.querySelector<HTMLElement>("code");
  if (!viewport || !code) return;
  const overflowing = !wrapper.classList.contains("is-wrapped") && code.scrollWidth > viewport.clientWidth + 1;
  wrapper.classList.toggle("has-horizontal-overflow", overflowing);
}

export function handleCodeBlockDisclosure(target: Element): void {
  const wrapper = target.closest<HTMLElement>(".code-block-wrapper");
  if (!wrapper) return;
  if (target.closest(".code-block-expand")) {
    wrapper.classList.add("is-expanded");
    target.closest<HTMLButtonElement>(".code-block-expand")?.setAttribute("aria-expanded", "true");
  }
  const wrapButton = target.closest<HTMLButtonElement>(".code-block-wrap");
  if (!wrapButton) return;
  const wrapped = wrapper.classList.toggle("is-wrapped");
  const label = wrapped ? "Disable word wrap" : "Enable word wrap";
  wrapButton.setAttribute("aria-pressed", String(wrapped));
  wrapButton.setAttribute("aria-label", label);
  wrapButton.title = label;
  updateCodeBlockWidthOverflow(wrapper);
}

let codeBlockRegionSequence = 0;
const initializedCodeBlocks = new WeakSet<HTMLElement>();

class MarkdownBlocksDirective extends AsyncDirective {
  private root: HTMLElement | undefined;
  private scanPending = false;
  private readonly observedNodes = new Set<HTMLElement>();
  private readonly resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver((entries) => {
    if (!this.isConnected) return;
    const wrappers = new Set(entries.map(({ target }) => target.closest<HTMLElement>(".code-block-wrapper")));
    for (const wrapper of wrappers) if (wrapper) updateCodeBlockWidthOverflow(wrapper);
  });

  render() { return nothing; }

  override update(part: ElementPart) {
    this.root = part.element instanceof HTMLElement ? part.element : undefined;
    this.scheduleScan();
    return nothing;
  }

  protected override disconnected(): void {
    this.resizeObserver?.disconnect();
    this.observedNodes.clear();
  }

  protected override reconnected(): void { this.scheduleScan(); }

  private scheduleScan(): void {
    if (this.scanPending || !this.isConnected) return;
    this.scanPending = true;
    queueMicrotask(() => {
      this.scanPending = false;
      if (this.isConnected && this.root?.isConnected) this.scan(this.root);
    });
  }

  private scan(root: HTMLElement): void {
    for (const node of this.observedNodes) {
      if (!root.contains(node)) {
        this.resizeObserver?.unobserve(node);
        this.observedNodes.delete(node);
      }
    }
    for (const wrapper of root.querySelectorAll<HTMLElement>(".code-block-wrapper")) {
      const viewport = wrapper.querySelector<HTMLElement>(".code-block-viewport");
      const code = viewport?.querySelector<HTMLElement>("code");
      if (!viewport || !code) continue;
      if (!initializedCodeBlocks.has(wrapper)) {
        initializedCodeBlocks.add(wrapper);
        const expandButton = wrapper.querySelector<HTMLButtonElement>(".code-block-expand");
        if (expandButton) {
          viewport.id = `code-block-${++codeBlockRegionSequence}`;
          expandButton.setAttribute("aria-controls", viewport.id);
        }
      }
      for (const node of [viewport, code]) {
        if (!this.observedNodes.has(node)) {
          this.observedNodes.add(node);
          this.resizeObserver?.observe(node);
        }
      }
      if (!this.resizeObserver) updateCodeBlockWidthOverflow(wrapper);
    }
  }
}

export const markdownBlocks = directive(MarkdownBlocksDirective);

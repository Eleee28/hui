/**
 * Full-screen viewer for transcript images and rendered diagrams: zoom, pan,
 * copy and save. One viewer exists at a time and lives in the browser's top
 * layer through a modal <dialog>, so it escapes every transcript/pane clip.
 */
import { html, nothing, svg, type SVGTemplateResult, type TemplateResult } from "lit";
import { HuiElement } from "../lit/hui-element.ts";
import { icons } from "../lib/icons.ts";
import { writeClipboardImage, writeClipboardText } from "../lib/clipboard.ts";
import { ensureModal } from "../lib/modal-dialog.ts";
import { fetchBlob } from "../api/files.ts";
import {
  ZOOM_STEP,
  centeredTransform,
  constrainTransform,
  dataUrlMime,
  downloadFilename,
  fitScale,
  formatZoom,
  svgIntrinsicSize,
  wheelZoomFactor,
  zoomAround,
  type Point,
  type Size,
  type ViewTransform,
} from "../lib/media-viewer.ts";

export type MediaViewerSource =
  | { kind: "image"; src: string; name: string }
  | { kind: "diagram"; svg: SVGSVGElement; name: string; label: string; source?: string };

type Busy = "" | "copy" | "source" | "save";
type Status = { tone: "ok" | "error"; text: string } | undefined;

const SVG_NS = "http://www.w3.org/2000/svg";
const PAN_STEP = 48;
const MAX_RASTER_EDGE = 8192;

// Lucide geometry (ISC) for controls the pinned OpenClaw icon set lacks.
function lucide(body: SVGTemplateResult): TemplateResult {
  return html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}
const viewerIcons = {
  zoomIn: lucide(svg`<circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35M11 8v6M8 11h6" />`),
  zoomOut: lucide(svg`<circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35M8 11h6" />`),
  code: lucide(svg`<path d="m16 18 6-6-6-6M8 6l-6 6 6 6" />`),
};

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

async function loadImage(src: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.decoding = "async";
  image.src = src;
  await image.decode();
  return image;
}

/** Resolves any CSS colour (including color-mix) to an opaque sRGB hex. */
function resolveColor(color: string): string {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return "#ffffff";
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, 1, 1);
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  const [r = 255, g = 255, b = 255] = context.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function rasterize(image: CanvasImageSource, size: Size, scale: number, background?: string): Promise<Blob> {
  const factor = Math.min(scale, MAX_RASTER_EDGE / Math.max(size.width, size.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(size.width * factor));
  canvas.height = Math.max(1, Math.round(size.height * factor));
  const context = canvas.getContext("2d");
  if (!context) return Promise.reject(new Error("Canvas is unavailable."));
  if (background) {
    context.fillStyle = background;
    context.fillRect(0, 0, canvas.width, canvas.height);
  }
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("The image could not be encoded."))), "image/png");
    } catch (error) {
      reject(error instanceof Error ? error : new Error("The image could not be encoded."));
    }
  });
}

const TEXT_SELECTOR = "foreignObject, foreignObject *, text, tspan";
const TEXT_PROPERTIES = ["font-family", "font-size", "font-style", "font-weight", "letter-spacing", "line-height"];
const HTML_PROPERTIES = ["color", "margin", "padding"];

/**
 * App stylesheets reach diagram labels in the document (Mermaid measures its
 * boxes with them) but not a standalone SVG file or image. Freeze the computed
 * typography onto the exported copy so labels keep the size they were laid out at.
 */
function inlineTextStyles(live: SVGSVGElement, copy: SVGSVGElement): void {
  const sources = live.querySelectorAll(TEXT_SELECTOR);
  const targets = copy.querySelectorAll(TEXT_SELECTOR);
  if (sources.length !== targets.length) return;
  sources.forEach((source, index) => {
    const target = targets[index] as HTMLElement | SVGElement | undefined;
    if (!target) return;
    const computed = getComputedStyle(source);
    const properties = source.namespaceURI === SVG_NS ? TEXT_PROPERTIES : [...TEXT_PROPERTIES, ...HTML_PROPERTIES];
    for (const property of properties) target.style.setProperty(property, computed.getPropertyValue(property));
  });
}

function triggerDownload(href: string, filename: string, host: Element): void {
  const link = document.createElement("a");
  link.href = href;
  link.download = filename;
  link.hidden = true;
  host.append(link);
  link.click();
  link.remove();
}

export class HuiMediaViewer extends HuiElement {
  static override properties = { source: { attribute: false } };
  declare source: MediaViewerSource | undefined;
  opener: HTMLElement | null = null;

  #transform: ViewTransform = { scale: 1, x: 0, y: 0 };
  #natural: Size | undefined;
  #fitScale = 1;
  #fitted = true;
  #loadFailed = false;
  #diagram: SVGSVGElement | undefined;
  #pointers = new Map<number, Point>();
  #drag: { origin: Point; start: ViewTransform } | undefined;
  #pinch: { distance: number; mid: Point; start: ViewTransform } | undefined;
  #moved = false;
  #busy: Busy = "";
  #status: Status;
  #statusTimer: ReturnType<typeof setTimeout> | undefined;
  #resize: ResizeObserver | undefined;

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.#resize?.disconnect();
    if (this.#statusTimer) clearTimeout(this.#statusTimer);
  }

  override firstUpdated(): void {
    const dialog = this.querySelector("dialog");
    const stage = this.#stage();
    if (!dialog || !stage) return;
    ensureModal(dialog);
    const source = this.source;
    if (source?.kind === "diagram") this.#mountDiagram(source.svg);
    else {
      const image = this.querySelector<HTMLImageElement>(".hui-media-viewer__image");
      if (image?.complete && image.naturalWidth > 0) this.#imageLoaded(image);
    }
    this.#resize = new ResizeObserver(() => (this.#fitted ? this.#fit() : this.#set(this.#transform)));
    this.#resize.observe(stage);
    stage.focus({ preventScroll: true });
  }

  #stage(): HTMLElement | null {
    return this.querySelector<HTMLElement>(".hui-media-viewer__stage");
  }

  #viewport(): Size {
    const rect = this.#stage()?.getBoundingClientRect();
    return { width: rect?.width ?? window.innerWidth, height: rect?.height ?? window.innerHeight };
  }

  #point(event: { clientX: number; clientY: number }): Point {
    const rect = this.#stage()?.getBoundingClientRect();
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
  }

  #mountDiagram(original: SVGSVGElement): void {
    const rect = original.getBoundingClientRect();
    const size = svgIntrinsicSize(original.getAttribute("viewBox"), original.getAttribute("width"), original.getAttribute("height"))
      ?? { width: Math.max(1, rect.width), height: Math.max(1, rect.height) };
    const clone = original.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("width", String(size.width));
    clone.setAttribute("height", String(size.height));
    clone.style.removeProperty("max-width");
    clone.style.removeProperty("max-height");
    clone.removeAttribute("tabindex");
    clone.setAttribute("aria-hidden", "true");
    this.#diagram = clone;
    // The diagram branch renders this container without Lit parts, so it is ours to fill.
    this.querySelector(".hui-media-viewer__content")?.replaceChildren(clone);
    this.#natural = size;
    this.#fit();
  }

  #imageLoaded(image: HTMLImageElement): void {
    this.#loadFailed = false;
    this.#natural = { width: image.naturalWidth || 1, height: image.naturalHeight || 1 };
    this.#fit();
  }

  #fit(): void {
    if (!this.#natural) return;
    const viewport = this.#viewport();
    this.#fitScale = fitScale(this.#natural, viewport, { maxScale: this.source?.kind === "diagram" ? 2 : 1 });
    this.#transform = centeredTransform(this.#natural, viewport, this.#fitScale);
    this.#fitted = true;
    this.#apply();
  }

  #set(transform: ViewTransform): void {
    if (!this.#natural) return;
    this.#transform = constrainTransform(transform, this.#natural, this.#viewport());
    this.#fitted = false;
    this.#apply();
  }

  #apply(): void {
    const content = this.querySelector<HTMLElement>(".hui-media-viewer__content");
    if (content && this.#natural) {
      const { scale, x, y } = this.#transform;
      content.style.width = `${this.#natural.width}px`;
      content.style.height = `${this.#natural.height}px`;
      content.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
      content.dataset["ready"] = "";
    }
    this.requestUpdate();
  }

  #zoomBy(factor: number, anchor?: Point): void {
    if (!this.#natural) return;
    const viewport = this.#viewport();
    this.#set(zoomAround(this.#transform, this.#transform.scale * factor, anchor ?? { x: viewport.width / 2, y: viewport.height / 2 }));
  }

  #zoomTo(scale: number, anchor?: Point): void {
    this.#zoomBy(scale / this.#transform.scale, anchor);
  }

  #toggleZoom(anchor: Point): void {
    if (this.#fitted) this.#zoomTo(Math.max(1, this.#fitScale * 2.5), anchor);
    else this.#fit();
  }

  #setStatus(status: Status): void {
    this.#status = status;
    if (this.#statusTimer) clearTimeout(this.#statusTimer);
    this.#statusTimer = setTimeout(() => {
      this.#status = undefined;
      this.requestUpdate();
    }, status?.tone === "error" ? 6000 : 2600);
    this.requestUpdate();
  }

  #diagramBackground(): string {
    const content = this.querySelector(".hui-media-viewer__content");
    return resolveColor(content ? getComputedStyle(content).backgroundColor : "#ffffff");
  }

  /** Standalone SVG document; the theme background keeps labels legible elsewhere. */
  #diagramMarkup(): string {
    if (!this.#diagram) throw new Error("The diagram is not ready.");
    const node = this.#diagram.cloneNode(true) as SVGSVGElement;
    inlineTextStyles(this.#diagram, node);
    node.setAttribute("xmlns", SVG_NS);
    node.removeAttribute("aria-hidden");
    node.style.backgroundColor = this.#diagramBackground();
    return new XMLSerializer().serializeToString(node);
  }

  async #pngBlob(): Promise<Blob> {
    const source = this.source;
    if (!source) throw new Error("Nothing to copy.");
    if (source.kind === "image") {
      const blob = await fetchBlob(source.src);
      if (blob.type === "image/png") return blob;
      const image = await loadImage(source.src);
      return rasterize(image, { width: image.naturalWidth || 1, height: image.naturalHeight || 1 }, 1);
    }
    const size = this.#natural ?? { width: 1, height: 1 };
    const image = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(this.#diagramMarkup())}`);
    return rasterize(image, size, 2, this.#diagramBackground());
  }

  #copyImage = async () => {
    if (this.#busy) return;
    this.#busy = "copy";
    this.requestUpdate();
    const result = await writeClipboardImage(this.#pngBlob());
    this.#busy = "";
    this.#setStatus(result === "image"
      ? { tone: "ok", text: "Image copied" }
      : result === "html"
        ? { tone: "ok", text: "Copied as rich content" }
        : { tone: "error", text: "The image could not be copied" });
  };

  #copySource = async () => {
    const source = this.source;
    if (this.#busy || source?.kind !== "diagram" || !source.source) return;
    this.#busy = "source";
    this.requestUpdate();
    const copied = await writeClipboardText(source.source);
    this.#busy = "";
    this.#setStatus(copied ? { tone: "ok", text: "Source copied" } : { tone: "error", text: "The source could not be copied" });
  };

  #save = async () => {
    const source = this.source;
    const dialog = this.querySelector("dialog");
    if (this.#busy || !source || !dialog) return;
    this.#busy = "save";
    this.requestUpdate();
    try {
      if (source.kind === "diagram") {
        const url = URL.createObjectURL(new Blob([this.#diagramMarkup()], { type: "image/svg+xml" }));
        triggerDownload(url, downloadFilename(source.name, "image/svg+xml", "diagram"), dialog);
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      } else {
        const blob = await fetchBlob(source.src);
        const url = URL.createObjectURL(blob);
        triggerDownload(url, downloadFilename(source.name, blob.type || dataUrlMime(source.src)), dialog);
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
      this.#setStatus({ tone: "ok", text: "Download started" });
    } catch (error) {
      this.#setStatus({ tone: "error", text: errorMessage(error, "The file could not be saved") });
    } finally {
      this.#busy = "";
      this.requestUpdate();
    }
  };

  #close = () => {
    this.querySelector("dialog")?.close();
  };

  #closed = () => {
    this.remove();
    if (current === this) current = undefined;
    if (this.opener?.isConnected) this.opener.focus({ preventScroll: true });
  };

  #keydown = (event: KeyboardEvent) => {
    const target = event.target instanceof Element ? event.target : null;
    if ((event.key === "Enter" || event.key === " ") && target?.closest("button, a")) return;
    if (event.altKey) return;
    if (event.ctrlKey || event.metaKey) {
      if (event.key.toLowerCase() === "c" && (document.getSelection()?.isCollapsed ?? true)) {
        event.preventDefault();
        void this.#copyImage();
      }
      return;
    }
    const actions: Record<string, () => void> = {
      "+": () => this.#zoomBy(ZOOM_STEP),
      "=": () => this.#zoomBy(ZOOM_STEP),
      "-": () => this.#zoomBy(1 / ZOOM_STEP),
      "_": () => this.#zoomBy(1 / ZOOM_STEP),
      "0": () => this.#fit(),
      "1": () => this.#zoomTo(1),
      ArrowLeft: () => this.#set({ ...this.#transform, x: this.#transform.x + PAN_STEP }),
      ArrowRight: () => this.#set({ ...this.#transform, x: this.#transform.x - PAN_STEP }),
      ArrowUp: () => this.#set({ ...this.#transform, y: this.#transform.y + PAN_STEP }),
      ArrowDown: () => this.#set({ ...this.#transform, y: this.#transform.y - PAN_STEP }),
    };
    const action = actions[event.key];
    if (!action) return;
    event.preventDefault();
    action();
  };

  #wheel = {
    handleEvent: (event: WheelEvent) => {
      event.preventDefault();
      this.#zoomBy(wheelZoomFactor(event.deltaY, event.deltaMode), this.#point(event));
    },
    passive: false,
  };

  #pointerDown = (event: PointerEvent) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const stage = this.#stage();
    if (!stage || !this.#natural) return;
    // A primary pointer starts a new gesture; drop pointers whose release was lost.
    if (event.isPrimary) this.#pointers.clear();
    if (this.#pointers.size === 0) this.#moved = false;
    this.#pointers.set(event.pointerId, this.#point(event));
    this.#beginGesture();
  };

  #beginGesture(): void {
    const [a, b] = [...this.#pointers.values()];
    this.#drag = undefined;
    this.#pinch = undefined;
    if (a && b) {
      this.#pinch = {
        distance: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
        mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        start: this.#transform,
      };
    } else if (a) {
      this.#drag = { origin: a, start: this.#transform };
    }
  }

  /** Capture only once a gesture starts, so plain clicks keep their real target. */
  #capture(): void {
    const stage = this.#stage();
    for (const id of this.#pointers.keys()) {
      if (stage && !stage.hasPointerCapture(id)) stage.setPointerCapture(id);
    }
  }

  #pointerMove = (event: PointerEvent) => {
    if (!this.#pointers.has(event.pointerId)) return;
    const point = this.#point(event);
    this.#pointers.set(event.pointerId, point);
    const [a, b] = [...this.#pointers.values()];
    if (this.#pinch && a && b) {
      const pinch = this.#pinch;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const zoomed = zoomAround(pinch.start, pinch.start.scale * (Math.hypot(b.x - a.x, b.y - a.y) / pinch.distance), pinch.mid);
      this.#moved = true;
      this.#capture();
      this.#set({ ...zoomed, x: zoomed.x + mid.x - pinch.mid.x, y: zoomed.y + mid.y - pinch.mid.y });
    } else if (this.#drag) {
      const dx = point.x - this.#drag.origin.x;
      const dy = point.y - this.#drag.origin.y;
      if (!this.#moved && Math.hypot(dx, dy) < 3) return;
      this.#moved = true;
      this.#capture();
      this.#set({ ...this.#drag.start, x: this.#drag.start.x + dx, y: this.#drag.start.y + dy });
    }
  };

  #pointerUp = (event: PointerEvent) => {
    if (!this.#pointers.delete(event.pointerId)) return;
    this.#beginGesture();
  };

  #stageClick = (event: MouseEvent) => {
    // A tap on the empty backdrop closes, like other lightboxes; drags never do.
    if (!this.#moved && event.target === event.currentTarget) this.#close();
  };

  #doubleClick = (event: MouseEvent) => {
    if (event.target === event.currentTarget) return;
    this.#toggleZoom(this.#point(event));
  };

  #button(label: string, icon: TemplateResult, onClick: () => void, options: { disabled?: boolean; busy?: boolean; className?: string } = {}): TemplateResult {
    return html`<button type="button" class="hui-media-viewer__button ${options.className ?? ""}" aria-label=${label} title=${label}
      ?disabled=${options.disabled ?? false} aria-busy=${options.busy ? "true" : "false"} @click=${onClick}>${icon}</button>`;
  }

  override render(): TemplateResult | typeof nothing {
    const source = this.source;
    if (!source) return nothing;
    const ready = Boolean(this.#natural);
    const label = source.kind === "diagram" ? source.label : "Image";
    const zoom = formatZoom(this.#transform.scale);
    const external = source.kind === "image" && !source.src.startsWith("data:");
    return html`<dialog class="hui-media-viewer" aria-label=${`${label} viewer: ${source.name}`} data-kind=${source.kind}
      @keydown=${this.#keydown} @close=${this.#closed}>
      <header class="hui-media-viewer__bar">
        <span class="hui-media-viewer__title" title=${source.name}>${source.name}</span>
        <span class="hui-media-viewer__status" role="status" data-tone=${this.#status?.tone ?? nothing}>${this.#status?.text ?? ""}</span>
        <div class="hui-media-viewer__actions" role="toolbar" aria-label=${`${label} controls`}>
          <div class="hui-media-viewer__zoom" role="group" aria-label="Zoom">
            ${this.#button("Zoom out", viewerIcons.zoomOut, () => this.#zoomBy(1 / ZOOM_STEP), { disabled: !ready })}
            <button type="button" class="hui-media-viewer__zoom-level" aria-label=${`Zoom ${zoom}. Fit to screen`} title="Fit to screen"
              ?disabled=${!ready} @click=${() => this.#fit()}>${zoom}</button>
            ${this.#button("Zoom in", viewerIcons.zoomIn, () => this.#zoomBy(ZOOM_STEP), { disabled: !ready })}
          </div>
          ${this.#button("Copy image", icons.copy, () => void this.#copyImage(), { disabled: !ready || this.#loadFailed, busy: this.#busy === "copy" })}
          ${source.kind === "diagram" && source.source
            ? this.#button("Copy source", viewerIcons.code, () => void this.#copySource(), { busy: this.#busy === "source" })
            : nothing}
          ${this.#button(source.kind === "diagram" ? "Save as SVG" : "Save image", icons.download, () => void this.#save(), { disabled: this.#loadFailed, busy: this.#busy === "save" })}
          ${external
            ? html`<a class="hui-media-viewer__button" href=${source.src} target="_blank" rel="noopener" aria-label="Open in new tab" title="Open in new tab">${icons.externalLink}</a>`
            : nothing}
          ${this.#button("Close viewer", icons.close, this.#close, { className: "hui-media-viewer__close" })}
        </div>
      </header>
      <div class="hui-media-viewer__stage" tabindex="0" autofocus aria-label=${`${label}: scroll or pinch to zoom, drag to pan`}
        @pointerdown=${this.#pointerDown} @pointermove=${this.#pointerMove} @pointerup=${this.#pointerUp} @pointercancel=${this.#pointerUp} @pointerleave=${this.#pointerUp}
        @wheel=${this.#wheel} @click=${this.#stageClick} @dblclick=${this.#doubleClick}>
        ${source.kind === "image"
          ? html`<div class="hui-media-viewer__content"><img class="hui-media-viewer__image" src=${source.src} alt=${source.name} draggable="false"
              @load=${(event: Event) => this.#imageLoaded(event.currentTarget as HTMLImageElement)}
              @error=${() => { this.#loadFailed = true; this.requestUpdate(); }}></div>`
          : html`<div class="hui-media-viewer__content"></div>`}
        ${this.#loadFailed ? html`<p class="hui-media-viewer__message" role="alert">The image could not be loaded.</p>` : nothing}
        ${!ready && !this.#loadFailed ? html`<p class="hui-media-viewer__message" role="status">Loading…</p>` : nothing}
      </div>
    </dialog>`;
  }
}

if (!customElements.get("hui-media-viewer")) customElements.define("hui-media-viewer", HuiMediaViewer);

let current: HuiMediaViewer | undefined;

/** Opens (or replaces) the single viewer; focus returns to `opener` on close. */
export function openMediaViewer(source: MediaViewerSource, opener?: HTMLElement | null): HuiMediaViewer {
  current?.remove();
  const viewer = document.createElement("hui-media-viewer") as HuiMediaViewer;
  viewer.source = source;
  viewer.opener = opener ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  current = viewer;
  document.body.append(viewer);
  return viewer;
}

/**
 * Transcript images opt in with `data-media-viewer` on the image or its
 * link. Modified clicks keep native link behaviour (new tab, download).
 */
function openFromClick(event: MouseEvent): void {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const trigger = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-media-viewer]") : null;
  if (!trigger) return;
  const image = trigger instanceof HTMLImageElement ? trigger : trigger.querySelector("img");
  if (!image || trigger.closest("[data-failed]") || (image.complete && image.naturalWidth === 0)) return;
  event.preventDefault();
  openMediaViewer({ kind: "image", src: image.currentSrc || image.src, name: trigger.dataset["mediaName"] || image.alt || "image" }, trigger);
}

let installed = false;
export function installMediaViewerTriggers(): void {
  if (installed) return;
  installed = true;
  document.addEventListener("click", openFromClick);
}

installMediaViewerTriggers();

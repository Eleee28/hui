/**
 * `<hui-bot-face>`: a bot's animated face (HUI-18), after OpenAI's Dots: a
 * plush shape in the bot's color with two dot eyes, no mouth and maybe ears on
 * top, whose eyes and body show what the bot is doing. Decorative: it is
 * aria-hidden, and the bot's name and status stay in text beside it.
 *
 * CSS keyframes carry the motion (src/styles/bot-face.css). This element adds
 * blinks and glances on light timers and, on large faces only, pointer gaze,
 * the blob's slow morph and an audio level on animation frames. It
 * pauses while the page is hidden, the face is off screen or disconnected,
 * and under prefers-reduced-motion it keeps one still expression per state.
 *
 * No decorators: the views that use it also load in Node tests.
 */
import { html, nothing, svg, type PropertyValues } from "lit";
import { HuiElement } from "../lit/hui-element.ts";
import { isBotFaceEars, isBotFaceShape } from "../lib/bots/bots.ts";
import type { BotFaceEars, BotFaceShape } from "../api/schema/bots.ts";
import {
  FACE_EYES,
  FACE_EYE_POSITION,
  FACE_FOLLOWS_POINTER,
  FACE_GAZE,
  FACE_LEAF_COLOR,
  SyllableLevel,
  eyesBlink,
  faceBodyColor,
  faceEars,
  faceInk,
  facePath,
  faceViewBox,
  isBotFaceState,
  isLiveFaceSize,
  levelSquash,
  pointerGaze,
  settlesWithDone,
  type BotFaceSize,
  type BotFaceState,
} from "../lib/bots/face.ts";
import { loadViewAssets } from "../lib/view-assets.ts";

loadViewAssets(() => import("../styles/bot-face.css"));

/** How long the one-shot "done" hop shows before the face rests. */
const DONE_MS = 1150;
/** Small faces crop the view box to the body, so a 32 px face is mostly face; tall ears grow it upward. */
const VIEW_BOX: Record<BotFaceSize, readonly [number, number, number]> = { sm: [12, 18, 96], md: [12, 18, 96], lg: [0, 0, 120], xl: [0, 0, 120] };

let instances = 0;

/* ── what every face shares: reduced motion, page visibility and one viewport observer ── */

type FaceListener = () => void;
const faces = new Set<FaceListener>();
let reducedQuery: MediaQueryList | undefined;
let observer: IntersectionObserver | undefined;
const onScreen = new WeakMap<Element, boolean>();
const observed = new WeakMap<Element, FaceListener>();

function notifyAll() {
  for (const listener of faces) listener();
}

function watchEnvironment(listener: FaceListener) {
  if (!faces.size && typeof window !== "undefined") {
    reducedQuery ??= window.matchMedia?.("(prefers-reduced-motion: reduce)");
    reducedQuery?.addEventListener?.("change", notifyAll);
    document.addEventListener("visibilitychange", notifyAll);
  }
  faces.add(listener);
}

function unwatchEnvironment(listener: FaceListener) {
  faces.delete(listener);
  if (!faces.size && typeof window !== "undefined") {
    reducedQuery?.removeEventListener?.("change", notifyAll);
    document.removeEventListener("visibilitychange", notifyAll);
  }
}

export function prefersReducedMotion(): boolean {
  return Boolean(reducedQuery?.matches);
}

function observe(element: Element, listener: FaceListener) {
  if (typeof IntersectionObserver !== "function") return;
  observer ??= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      onScreen.set(entry.target, entry.isIntersecting);
      observed.get(entry.target)?.();
    }
  }, { rootMargin: "64px" });
  observed.set(element, listener);
  observer.observe(element);
}

function unobserve(element: Element) {
  observer?.unobserve(element);
  observed.delete(element);
  onScreen.delete(element);
}

export class HuiBotFace extends HuiElement {
  static override properties = {
    shape: { type: String, reflect: true },
    ears: { type: String },
    color: { type: String },
    state: { type: String, reflect: true },
    size: { type: String, reflect: true },
    seed: { type: Number },
    shown: { state: true },
  };
  declare shape: BotFaceShape;
  /** What sits on top; "" or anything else: nothing. */
  declare ears: BotFaceEars | "";
  /** #rrggbb */
  declare color: string;
  declare state: BotFaceState;
  declare size: BotFaceSize;
  /** Seeds the plush texture and the blob's wobble; the bot's id gives the same face everywhere. */
  declare seed: number;
  /** An audio level, 0–1, read every frame while the face speaks or listens (large faces only); not
   * reactive, so a new source costs no render. Undefined, or a source that answers undefined: the prototype's
   * syllable rhythm stands in. */
  level: (() => number | undefined) | undefined;
  /** Internal: the state on screen, which plays "done" for a moment when a turn ends. */
  declare shown: BotFaceState;

  readonly #id = ++instances;
  #connected = false;
  #active = false;
  #blinkTimer: ReturnType<typeof setTimeout> | undefined;
  #glanceTimer: ReturnType<typeof setTimeout> | undefined;
  #doneTimer: ReturnType<typeof setTimeout> | undefined;
  #frame = 0;
  #phase = 0;
  #lastMorph = 0;
  #amp = 0;
  #side = 1;
  #pointer = false;
  #stage: Element | undefined;
  readonly #syllables = new SyllableLevel();
  readonly #onEnvironment = () => this.#sync();

  constructor() {
    super();
    this.shape = "blob";
    this.ears = "";
    this.color = "#3a7bfa";
    this.state = "idle";
    this.size = "md";
    this.seed = 0;
    this.level = undefined;
    this.shown = "idle";
  }

  override connectedCallback() {
    super.connectedCallback();
    this.setAttribute("aria-hidden", "true");
    this.#connected = true;
    watchEnvironment(this.#onEnvironment);
    observe(this, this.#onEnvironment);
    this.#attachStage();
    this.#sync();
  }

  override disconnectedCallback() {
    this.#connected = false;
    unwatchEnvironment(this.#onEnvironment);
    unobserve(this);
    this.#detachStage();
    if (this.#doneTimer) this.#endHop();
    this.#sync();
    super.disconnectedCallback();
  }

  protected override willUpdate(changed: PropertyValues<this>) {
    if (changed.has("state")) {
      const next = isBotFaceState(this.state) ? this.state : "idle";
      const previous = changed.get("state") as BotFaceState | undefined;
      clearTimeout(this.#doneTimer);
      this.#doneTimer = undefined;
      // A turn that just ended (or an explicit "done") hops once, then rests; the first render never does.
      if (next === "done" || (previous !== undefined && this.hasUpdated && settlesWithDone(previous, next))) {
        this.shown = "done";
        this.#doneTimer = setTimeout(() => this.#endHop(), DONE_MS);
      } else {
        this.shown = next;
      }
    }
  }

  #endHop() {
    clearTimeout(this.#doneTimer);
    this.#doneTimer = undefined;
    this.shown = this.state === "done" ? "idle" : isBotFaceState(this.state) ? this.state : "idle";
  }

  protected override updated(changed: PropertyValues<this>) {
    if (changed.has("shape") || changed.has("seed")) {
      this.#phase = (this.seed % 600) / 100;
      this.#drawBody();
    }
    if (changed.has("shown") && !this.#pointer) this.#restGaze();
    if (changed.has("shown") || changed.has("size") || changed.has("shape")) {
      // Speaking and listening move the body each frame; any other state hands it back to the keyframes.
      if (this.shown !== "speaking" && this.shown !== "listening") this.#squash?.style.removeProperty("transform");
      if (!FACE_FOLLOWS_POINTER.has(this.shown)) this.#lean?.style.removeProperty("transform");
      this.#sync();
    }
  }

  get #svg() { return this.querySelector<SVGSVGElement>("svg"); }
  get #squash() { return this.querySelector<SVGGElement>(".bot-face__squash"); }
  get #lean() { return this.querySelector<SVGGElement>(".bot-face__lean"); }
  get #gaze() { return this.querySelector<SVGGElement>(".bot-face__gaze"); }
  get #eyes() { return this.querySelector<SVGGElement>(".bot-face__eyes"); }

  #drawBody() {
    const d = facePath(isBotFaceShape(this.shape) ? this.shape : "blob", this.#phase);
    for (const path of this.querySelectorAll<SVGPathElement>(".bot-face__body, .bot-face__shade")) path.setAttribute("d", d);
  }

  #look(x: number, y: number) {
    this.#gaze?.style.setProperty("transform", "translate(" + x + "px," + y + "px)");
  }

  #restGaze() {
    const [x, y] = FACE_GAZE[this.shown];
    this.#look(x, y);
  }

  /** Starts or stops the timers and the frame loop to match what the face may do now. */
  #sync() {
    const live = isLiveFaceSize(this.size);
    const active = this.#connected && !prefersReducedMotion() && (typeof document === "undefined" || !document.hidden) && onScreen.get(this) !== false;
    this.toggleAttribute("data-paused", this.#connected && !active);
    if (active !== this.#active) {
      this.#active = active;
      if (active) {
        this.#scheduleBlink();
        this.#scheduleGlance();
      } else {
        clearTimeout(this.#blinkTimer);
        clearTimeout(this.#glanceTimer);
        this.#blinkTimer = this.#glanceTimer = undefined;
        this.#eyes?.classList.remove("blink");
        this.#pointer = false;
        this.#lean?.style.removeProperty("transform");
        if (this.hasUpdated) this.#restGaze();
      }
    } else if (active && this.shown === "thinking") {
      // Thinking glances side to side more often; restart the glance clock on entering it.
      this.#scheduleGlance();
    }
    const framed = active && live && (this.shown === "speaking" || this.shown === "listening" || this.shape === "blob");
    if (framed && !this.#frame) this.#frame = requestAnimationFrame(this.#tick);
    if (!framed && this.#frame) {
      cancelAnimationFrame(this.#frame);
      this.#frame = 0;
    }
    if (!active || !(this.shown === "speaking" || this.shown === "listening")) this.#amp = 0;
  }

  #scheduleBlink() {
    clearTimeout(this.#blinkTimer);
    if (!this.#active) return;
    this.#blinkTimer = setTimeout(() => {
      if (eyesBlink(FACE_EYES[this.shown])) {
        this.#blink(110);
        if (Math.random() < 0.22) setTimeout(() => { if (this.#active) this.#blink(95); }, 230);
      }
      this.#scheduleBlink();
    }, 2200 + Math.random() * 3800);
  }

  #blink(ms: number) {
    const eyes = this.#eyes;
    if (!eyes) return;
    eyes.classList.add("blink");
    setTimeout(() => eyes.classList.remove("blink"), ms);
  }

  #scheduleGlance() {
    clearTimeout(this.#glanceTimer);
    if (!this.#active) return;
    const wait = this.shown === "thinking" ? 1300 + Math.random() * 900 : 3500 + Math.random() * 4500;
    this.#glanceTimer = setTimeout(() => {
      if (!this.#pointer) {
        if (this.shown === "idle") {
          this.#look(Math.round((Math.random() * 2 - 1) * 600) / 100, Math.round((Math.random() * 2 - 1) * 300) / 100);
          setTimeout(() => { if (!this.#pointer && this.shown === "idle") this.#look(0, 0); }, 800 + Math.random() * 900);
        } else if (this.shown === "thinking") {
          this.#side = -this.#side;
          this.#look(this.#side * 5, -4.2);
        }
      }
      this.#scheduleGlance();
    }, wait);
  }

  readonly #tick = (now: number) => {
    this.#frame = 0;
    if (!this.#active) return;
    const state = this.shown;
    if (state === "speaking" || state === "listening") {
      const measured = this.level?.();
      const target = typeof measured === "number" && Number.isFinite(measured) ? Math.max(0, Math.min(1, measured)) : this.#syllables.at(now, state === "listening");
      this.#amp += (target - this.#amp) * 0.35;
      this.#squash?.style.setProperty("transform", levelSquash(state, this.#amp));
    }
    if (this.shape === "blob" && now - this.#lastMorph > 33) {
      this.#phase += 0.02;
      this.#lastMorph = now;
      this.#drawBody();
    }
    if (isLiveFaceSize(this.size) && (state === "speaking" || state === "listening" || this.shape === "blob")) this.#frame = requestAnimationFrame(this.#tick);
  };

  /* ── pointer gaze: the nearest [data-face-stage], else the face's parent ── */

  #attachStage() {
    this.#detachStage();
    const stage = this.closest("[data-face-stage]") ?? this.parentElement ?? undefined;
    if (!stage) return;
    this.#stage = stage;
    stage.addEventListener("pointermove", this.#onPointerMove as EventListener, { passive: true });
    stage.addEventListener("pointerleave", this.#onPointerLeave);
  }

  #detachStage() {
    this.#stage?.removeEventListener("pointermove", this.#onPointerMove as EventListener);
    this.#stage?.removeEventListener("pointerleave", this.#onPointerLeave);
    this.#stage = undefined;
  }

  readonly #onPointerMove = (event: PointerEvent) => {
    if (!this.#active || !isLiveFaceSize(this.size) || !FACE_FOLLOWS_POINTER.has(this.shown)) return;
    const box = this.#svg?.getBoundingClientRect();
    if (!box || !box.width) return;
    const gaze = pointerGaze(event.clientX - (box.left + box.width / 2), event.clientY - (box.top + box.height / 2), box.width);
    this.#pointer = true;
    this.#look(gaze.x, gaze.y);
    this.#lean?.style.setProperty("transform", "rotate(" + gaze.lean + "deg)");
  };

  readonly #onPointerLeave = () => {
    if (!this.#pointer) return;
    this.#pointer = false;
    this.#lean?.style.removeProperty("transform");
    this.#restGaze();
  };

  override render() {
    const id = this.#id;
    const size = (["sm", "md", "lg", "xl"] as const).includes(this.size) ? this.size : "md";
    const shape = isBotFaceShape(this.shape) ? this.shape : "blob";
    const state = this.shown;
    const body = faceBodyColor(this.color, state);
    const ink = faceInk(body);
    const [x, y] = FACE_EYE_POSITION[shape];
    const ears = isBotFaceEars(this.ears) ? faceEars(shape, this.ears) : undefined;
    const leaf = faceBodyColor(FACE_LEAF_COLOR, state);
    const line = { stroke: ink, width: "2.6" };
    const eye = (side: -1 | 1) => svg`<g transform=${"translate(" + side * 11 + ",0)"}>
      <ellipse class="e e-open" rx="4.3" ry="5.6" fill=${ink}></ellipse>
      <circle class="e e-open" cx="-1.4" cy="-2.1" r="1.3" fill=${ink === "#141414" ? "#fff" : "#141414"} fill-opacity=".9"></circle>
      <path class="e e-closed" d="M-4.6 0.6 L4.6 0.6" stroke=${line.stroke} stroke-width=${line.width} stroke-linecap="round" fill="none"></path>
      <path class="e e-happy" d="M-4.8 2.4 Q0 -4.4 4.8 2.4" stroke=${line.stroke} stroke-width=${line.width} stroke-linecap="round" fill="none"></path>
      <path class="e e-sleepy" d="M-4.8 -1.2 Q0 3.9 4.8 -1.2" stroke=${line.stroke} stroke-width=${line.width} stroke-linecap="round" fill="none"></path>
      <path class="e e-brow" d=${side < 0 ? "M-5.4 -9.2 L3.2 -11.6" : "M-3.2 -11.6 L5.4 -9.2"} stroke=${line.stroke} stroke-width="2.1" stroke-linecap="round" fill="none"></path>
    </g>`;
    return html`<svg class="bot-face" viewBox=${faceViewBox(VIEW_BOX[size], ears?.top)} focusable="false" aria-hidden="true" data-state=${state} data-eyes=${FACE_EYES[state]}>
      <defs>
        <radialGradient id=${"bot-face-g" + id} cx="36%" cy="28%" r="80%">
          <stop offset="0" stop-color="#fff" stop-opacity=".45"></stop>
          <stop offset=".42" stop-color="#fff" stop-opacity="0"></stop>
          <stop offset="1" stop-color="#000" stop-opacity=".24"></stop>
        </radialGradient>
        <!-- Felt speckle inside the outline; the outline itself stays smooth. -->
        <filter id=${"bot-face-p" + id}>
          <feTurbulence type="fractalNoise" baseFrequency="2.4" numOctaves="1" seed=${String((this.seed % 997) * 3 + 4)} result="f"></feTurbulence>
          <feColorMatrix in="f" type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 .16 0" result="s"></feColorMatrix>
          <feComposite in="s" in2="SourceGraphic" operator="in" result="si"></feComposite>
          <feMerge><feMergeNode in="SourceGraphic"></feMergeNode><feMergeNode in="si"></feMergeNode></feMerge>
        </filter>
        <filter id=${"bot-face-b" + id} x="-30%" y="-200%" width="160%" height="500%"><feGaussianBlur stdDeviation="2.2"></feGaussianBlur></filter>
      </defs>
      <ellipse class="bot-face__shadow" cx="60" cy="110" rx="29" ry="4.6" fill="#000" fill-opacity=".16" filter=${"url(#bot-face-b" + id + ")"}></ellipse>
      <g class="bot-face__lean fx"><g class="bot-face__bob fx"><g class="bot-face__tilt fx"><g class="bot-face__squash fx">
        <g filter=${"url(#bot-face-p" + id + ")"}>
          ${ears?.parts.map((part) => svg`<path class="bot-face__ear" d=${part.d} transform=${part.transform} fill=${part.leaf ? leaf : body}></path>`)}
          <path class="bot-face__body" fill=${body}></path>
          <path class="bot-face__shade" fill=${"url(#bot-face-g" + id + ")"}></path>
        </g>
        <g transform=${"translate(" + x + "," + y + ")"}>
          <g class="bot-face__gaze"><g class="bot-face__eyes">${eye(-1)}${eye(1)}</g></g>
        </g>
        <!-- A pair of ears takes the dots' corner: sleepy eyes and the slow breath show the memory state there. -->
        ${ears?.pair ? nothing : svg`<g class="bot-face__thoughts">
          <circle cx="80" cy="30" r="2.2" fill="currentColor"></circle>
          <circle cx="88" cy="21" r="3" fill="currentColor" style="animation-delay: .35s"></circle>
          <circle cx="98" cy="11" r="3.9" fill="currentColor" style="animation-delay: .7s"></circle>
        </g>`}
      </g></g></g></g>
    </svg>`;
  }

  protected override firstUpdated() {
    this.#phase = (this.seed % 600) / 100;
    this.#drawBody();
    this.#restGaze();
    this.#sync();
  }
}

if (typeof customElements !== "undefined" && !customElements.get("hui-bot-face")) customElements.define("hui-bot-face", HuiBotFace);

declare global {
  interface HTMLElementTagNameMap {
    "hui-bot-face": HuiBotFace;
  }
}

// OpenClaw v2026.9.5, ec9c1a13; MIT License.
// Textarea sizing/overflow controller from pages/chat/components/chat-composer-dom.ts.
// Session-scroll persistence is not ported; its pure 8px end-anchor calculation is.
type ComposerTextareaResizeObserverState = {
  observer: ResizeObserver | null;
  adjustmentFrame: number | null;
  editing: boolean;
  events: AbortController;
};
const composerTextareaResizeObservers = new WeakMap<HTMLTextAreaElement, ComposerTextareaResizeObserverState>();
function captureChatSessionScrollPosition(target: HTMLElement) {
  const maxScrollTop = Math.max(0, target.scrollHeight - target.clientHeight);
  const scrollTop = Math.min(Math.max(0, target.scrollTop), maxScrollTop);
  return { scrollTop, anchorToEnd: maxScrollTop - scrollTop <= 8 };
}

function updateTextareaOverflow(el: HTMLTextAreaElement) {
  const scrollable = el.scrollHeight > el.clientHeight + 1;
  // Two 16px fades need enough vertical runway not to overlap into a narrow
  // opaque strip on short drafts. Small overflows still scroll, just unfaded.
  const canFade =
    scrollable && el.clientHeight >= 64 && !composerTextareaResizeObservers.get(el)?.editing;
  const fadeTop = canFade && el.scrollTop > 1;
  const fadeBottom = canFade && el.scrollTop + el.clientHeight < el.scrollHeight - 1;
  el.style.overflowY = scrollable ? "auto" : "hidden";
  el.toggleAttribute("data-scroll-fade-top", fadeTop);
  el.toggleAttribute("data-scroll-fade-bottom", fadeBottom);
}

export function adjustTextareaHeight(el: HTMLTextAreaElement) {
  // A surface that declares the compact shape is a fixed CSS box: it holds one
  // line whatever the draft is, so an inline height left by an earlier measured
  // pass would silently outrank the stylesheet. Which shape a composer is in is
  // declared in its markup, never inferred here from how much text it holds.
  if (el.closest('[data-composer-layout="single-line"]')) {
    el.style.height = "";
    el.style.overflowY = "";
    el.removeAttribute("data-scroll-fade-top");
    el.removeAttribute("data-scroll-fade-bottom");
    return;
  }
  const thread = el.closest(".chat")?.querySelector<HTMLElement>(".chat-thread") ?? null;
  const preserveBottomAnchor = thread
    ? captureChatSessionScrollPosition(thread).anchorToEnd
    : false;
  // Hide the browser's scrollbar while measuring; restore it only when the
  // final CSS-constrained height actually clips the draft.
  el.style.overflowY = "hidden";
  el.style.height = "auto";
  // The owning surface declares its cap in CSS. Retain the historical fallback
  // for detached/test controls whose computed max-height is not a pixel value.
  const computedMaxHeight = getComputedStyle(el).maxHeight.trim();
  const pixelMaxHeight = /^(\d+(?:\.\d+)?)px$/u.exec(computedMaxHeight);
  const maxHeight = pixelMaxHeight ? Number(pixelMaxHeight[1]) : 150;
  el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  updateTextareaOverflow(el);
  // Once capped, the textarea can perturb the sibling transcript without
  // resizing its viewport, so ResizeObserver has no correction to apply.
  if (thread && preserveBottomAnchor) {
    thread.scrollTop = thread.scrollHeight;
  }
}

export function observeTextareaOverflow(el: HTMLTextAreaElement) {
  if (composerTextareaResizeObservers.has(el)) {
    return;
  }
  const state: ComposerTextareaResizeObserverState = {
    observer: null,
    adjustmentFrame: null,
    editing: false,
    events: new AbortController(),
  };
  let width = el.getBoundingClientRect().width;
  const onScroll = () => updateTextareaOverflow(el);
  state.observer =
    typeof ResizeObserver === "function"
      ? new ResizeObserver(() => {
          const nextWidth = el.getBoundingClientRect().width;
          if (nextWidth !== width) {
            width = nextWidth;
            if (
              composerTextareaResizeObservers.get(el) === state &&
              state.adjustmentFrame === null
            ) {
              state.adjustmentFrame = requestAnimationFrame(() => {
                state.adjustmentFrame = null;
                if (composerTextareaResizeObservers.get(el) === state) {
                  adjustTextareaHeight(el);
                }
              });
            }
            return;
          }
          updateTextareaOverflow(el);
        })
      : null;
  // Native caret scrolling can leave the active line inside the fade. Keep
  // editing unfaded until explicit navigation; a scroll event alone cannot
  // distinguish the browser following the caret from the user browsing text.
  const onInteraction = (event: Event) => {
    if (
      event instanceof KeyboardEvent &&
      (event.isComposing ||
        !/^(ArrowUp|ArrowDown|ArrowLeft|ArrowRight|PageUp|PageDown|Home|End)$/u.test(event.key))
    ) {
      return;
    }
    state.editing = ["beforeinput", "input", "compositionstart"].includes(event.type);
    updateTextareaOverflow(el);
  };
  const eventOptions = { passive: true, signal: state.events.signal };
  for (const type of [
    "beforeinput",
    "input",
    "compositionstart",
    "wheel",
    "pointerdown",
    "keydown",
    "blur",
  ]) {
    el.addEventListener(type, onInteraction, eventOptions);
  }
  el.addEventListener("scroll", onScroll, eventOptions);
  composerTextareaResizeObservers.set(el, state);
  state.observer?.observe(el);
  updateTextareaOverflow(el);
}

export function disconnectTextareaOverflowObserver(el: HTMLTextAreaElement) {
  const state = composerTextareaResizeObservers.get(el);
  composerTextareaResizeObservers.delete(el);
  if (!state) {
    return;
  }
  state.observer?.disconnect();
  state.events.abort();
  if (state.adjustmentFrame !== null) {
    cancelAnimationFrame(state.adjustmentFrame);
  }
}

export function scheduleTextareaHeightAdjustment(el: HTMLTextAreaElement) {
  // Lit invokes ref callbacks before the textarea is connected and before its
  // controlled value is committed, so measure once the render has settled.
  queueMicrotask(() => {
    if (el.isConnected) {
      adjustTextareaHeight(el);
    }
  });
}

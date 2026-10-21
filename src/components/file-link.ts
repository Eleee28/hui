/**
 * `<hui-file-ref>`: a file reference the agent wrote in the chat (an inline code span or a Markdown link that looks
 * like a path; see `lib/files/references.ts`, emitted by the agent Markdown renderer and the read/edit/write tool
 * cards). It renders as its plain content until the gateway confirms the path exists inside the conversation's working
 * directory (`lib/files/file-link-store.ts`); then only its colour and cursor change, so nothing reflows, and it becomes a
 * keyboard-operable link that dispatches `OPEN_FILE_EVENT` for the app to open in the Work pane's Files view.
 *
 * The conversation comes from the nearest `[data-hui-files-session]` ancestor (the chat thread); without one (a
 * hovercard, the Files view's own Markdown preview) a reference stays plain. A plain custom element, not Lit: it
 * lives inside Markdown HTML and holds no template of its own.
 */
import { resolveFilePaths, FilesRequestError } from "../api/files.ts";
import { createFileLinkResolver, OPEN_FILE_EVENT, type OpenFileDetail } from "../lib/files/file-link-store.ts";
import { TURN_END_EVENT, type TurnEndDetail } from "../lib/session/turn-end.ts";
import type { FileLocation } from "../api/schema/files.ts";

export const fileLinkResolver = createFileLinkResolver(async (sessionId, paths) => {
  try {
    return await resolveFilePaths(sessionId, paths);
  } catch (error) {
    // A remote worker's conversation (409) or a directory that is gone (404): nothing in it is a link.
    if (error instanceof FilesRequestError && (error.status === 409 || error.status === 404)) return "unavailable";
    throw error;
  }
});

/** The accessible name and tooltip of a confirmed reference. */
export function fileLinkLabel(location: FileLocation, line?: number): string {
  const what = location.kind === "directory" ? `folder ${location.path || "the working directory"}` : location.path;
  return `Open ${what}${line ? ` at line ${line}` : ""} in Files`;
}

function positiveData(value: string | undefined): number | undefined {
  const number = Number(value);
  return value && Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

const connected = new Set<HuiFileRef>();

const Base = (typeof HTMLElement === "undefined" ? class {} : HTMLElement) as typeof HTMLElement;

export class HuiFileRef extends Base {
  private location: FileLocation | null = null;
  private sessionId = "";

  connectedCallback() {
    connected.add(this);
    this.addEventListener("click", this.onClick);
    this.addEventListener("keydown", this.onKeydown);
    this.check();
  }

  disconnectedCallback() {
    connected.delete(this);
    this.removeEventListener("click", this.onClick);
    this.removeEventListener("keydown", this.onKeydown);
  }

  /** Asks (or reads the cached answer) whether this reference exists. */
  check() {
    const sessionId = this.closest<HTMLElement>("[data-hui-files-session]")?.dataset["huiFilesSession"] ?? "";
    const path = this.dataset["path"] ?? "";
    this.sessionId = sessionId;
    if (!sessionId || !path) {
      this.apply(null);
      return;
    }
    const known = fileLinkResolver.lookup(sessionId, path);
    if (known !== undefined) {
      this.apply(known);
      return;
    }
    void fileLinkResolver.resolve(sessionId, path).then((location) => {
      if (this.isConnected && this.sessionId === sessionId && this.dataset["path"] === path) this.apply(location);
    });
  }

  get linked(): boolean {
    return this.location !== null;
  }

  private apply(location: FileLocation | null) {
    this.location = location;
    if (!location) {
      this.classList.remove("is-linked");
      for (const name of ["role", "tabindex", "aria-label", "data-hui-tooltip"]) this.removeAttribute(name);
      return;
    }
    const label = fileLinkLabel(location, positiveData(this.dataset["line"]));
    this.classList.add("is-linked");
    this.setAttribute("role", "link");
    this.setAttribute("tabindex", "0");
    this.setAttribute("aria-label", label);
    this.setAttribute("data-hui-tooltip", label);
  }

  private open() {
    const location = this.location;
    if (!location || !this.sessionId) return;
    const line = positiveData(this.dataset["line"]);
    const column = line ? positiveData(this.dataset["column"]) : undefined;
    const detail: OpenFileDetail = {
      sessionId: this.sessionId,
      path: location.path,
      kind: location.kind,
      ...(line ? { line } : {}),
      ...(column ? { column } : {}),
    };
    this.dispatchEvent(new CustomEvent<OpenFileDetail>(OPEN_FILE_EVENT, { bubbles: true, composed: true, detail }));
  }

  private onClick = (event: MouseEvent) => {
    if (!this.location || event.button !== 0) return;
    // Selecting the path's text is not a click on it.
    const selection = globalThis.getSelection?.();
    if (selection && !selection.isCollapsed && [selection.anchorNode, selection.focusNode].some((node) => node && this.contains(node))) return;
    event.preventDefault();
    this.open();
  };

  private onKeydown = (event: KeyboardEvent) => {
    if (!this.location || event.key !== "Enter" || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    event.preventDefault();
    this.open();
  };
}

if (typeof customElements !== "undefined" && !customElements.get("hui-file-ref")) {
  customElements.define("hui-file-ref", HuiFileRef);
  // The agent may have created a file it named before: ask again about the conversation's missing ones.
  globalThis.addEventListener?.(TURN_END_EVENT, (event) => {
    const sessionId = (event as CustomEvent<TurnEndDetail>).detail?.sessionId;
    if (!sessionId) return;
    fileLinkResolver.forgetMissing(sessionId);
    for (const element of connected) if (element.isConnected && !element.linked) element.check();
  });
}

declare global {
  interface HTMLElementTagNameMap {
    "hui-file-ref": HuiFileRef;
  }
}

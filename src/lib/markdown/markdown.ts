/**
 * HUI's Markdown renderer for chat. It configures markdown-it with HUI's extensions (details, math, alerts,
 * task lists, rich embeds, Mermaid and chart fences) and its safety rules: raw HTML is escaped, links are
 * limited to safe schemes and remote images are never loaded. Output is memoised per source because Lit
 * re-renders the whole transcript on every update.
 *
 * The agent's own replies render through a second instance (`renderAgentMarkdown`) that also wraps file references
 * — inline code spans and link targets shaped like paths (`../files/references.ts`) — in `<hui-file-ref>`, which
 * becomes a link to the Files view once the gateway confirms the path (`components/file-link.ts`). Fenced code,
 * prose and other Markdown (hovercards, the Files view's preview, user messages) are never wrapped. It draws Slack
 * and X links as cards only when asked: the chat does so on its latest messages and leaves older ones plain links.
 */
import MarkdownIt, { type MarkdownIt as MarkdownItParser, type StateBlock, type StateCore, type StateInline, type Token } from "markdown-it";
import markdownItCjkFriendly from "markdown-it-cjk-friendly";
import markdownItTaskLists from "markdown-it-task-lists";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { parseSlackLink } from "./slack-link.ts";
import { parseFileLinkTarget, parseFileReference, type FileReference } from "../files/references.ts";

const DISALLOWED_LINK_SCHEME_RE = /^(?!(?:https?|mailto):)[a-z][a-z0-9+.-]*:/i;
const INLINE_DATA_IMAGE_RE = /^data:image\/[a-z0-9.+-]+;base64,/i;
const CJK_RE = /[\u2e80-\u2fff\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff01-\uff60]/;
const ALERT_MARKER_RE = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/iu;
const ALERT_LABELS = { note: "Note", tip: "Tip", important: "Important", warning: "Warning", caution: "Caution" } as const;
type AlertType = keyof typeof ALERT_LABELS;

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function renderCodeBlock(text: string, language: string): string {
  const lang = language.trim().split(/\s+/)[0] ?? "";
  const lineCount = text.endsWith("\n") ? text.slice(0, -1).split("\n").length : text.split("\n").length;
  const hiddenLines = ["text", "md", "markdown"].includes(lang.toLowerCase()) ? 0 : Math.max(0, lineCount - 7);
  const languageClass = lang ? ` class="language-${escapeHtml(lang)}"` : "";
  const expand = hiddenLines
    ? `<button type="button" class="code-block-expand" aria-label="Show ${hiddenLines} hidden ${hiddenLines === 1 ? "line" : "lines"}" aria-expanded="false"><span class="code-block-chevron" aria-hidden="true"></span><span>${hiddenLines} hidden ${hiddenLines === 1 ? "line" : "lines"}</span></button>`
    : "";
  return `<div class="code-block-wrapper${hiddenLines ? " is-collapsible" : ""}"><div class="code-block-header"><span class="code-block-lang">${escapeHtml(lang || "code")}</span><div class="code-block-actions"><button type="button" class="code-block-wrap" aria-label="Enable word wrap" title="Enable word wrap" aria-pressed="false"><span class="code-block-wrap__enable" aria-hidden="true"></span><span class="code-block-wrap__disable" aria-hidden="true"></span></button><button type="button" class="code-block-copy" data-copy-code aria-label="Copy code"><span class="code-block-copy__idle" aria-hidden="true"></span><span class="code-block-copy__done" aria-hidden="true"></span><span class="code-block-copy__failed" aria-hidden="true">!</span></button></div></div><div class="code-block-viewport"><pre><code${languageClass}>${escapeHtml(text)}</code></pre></div>${expand}</div>`;
}

function installDetails(parser: MarkdownItParser): void {
  type DetailsState = StateBlock & { huiDetailsDepth?: number };
  const TAG_RE = /<details( open)?>|<\/details>|<summary>(.*?)<\/summary>/gi;
  const rule = (state: StateBlock, startLine: number, _endLine: number, silent: boolean): boolean => {
    if ((state.sCount[startLine] ?? 0) - state.blkIndent >= 4) return false;
    const start = (state.bMarks[startLine] ?? 0) + (state.tShift[startLine] ?? 0);
    const end = state.eMarks[startLine] ?? state.src.length;
    const line = state.src.slice(start, end);
    if (!/^\s*<(?:details|\/details|summary)(?=[\s>])/i.test(line)) return false;
    if (silent) return true;
    const detailsState = state as DetailsState;
    let cursor = 0;
    for (const match of line.matchAll(TAG_RE)) {
      const leading = line.slice(cursor, match.index);
      if (leading.trim()) {
        const inline = state.push("inline", "", 0);
        inline.content = leading.trim();
        inline.children = [];
      }
      const raw = match[0].toLowerCase();
      if (raw.startsWith("<details")) {
        const token = state.push("details_open", "details", 1);
        if (match[1]) token.attrSet("open", "");
        detailsState.huiDetailsDepth = (detailsState.huiDetailsDepth ?? 0) + 1;
      } else if (raw === "</details>" && (detailsState.huiDetailsDepth ?? 0) > 0) {
        state.push("details_close", "details", -1);
        detailsState.huiDetailsDepth = Math.max(0, (detailsState.huiDetailsDepth ?? 0) - 1);
      } else if (raw.startsWith("<summary>") && (detailsState.huiDetailsDepth ?? 0) > 0) {
        state.push("summary_open", "summary", 1);
        const inline = state.push("inline", "", 0);
        inline.content = match[2] ?? "";
        inline.children = [];
        state.push("summary_close", "summary", -1);
      } else {
        const inline = state.push("inline", "", 0);
        inline.content = match[0];
        inline.children = [];
      }
      cursor = (match.index ?? 0) + match[0].length;
    }
    const trailing = line.slice(cursor);
    if (trailing.trim()) {
      const inline = state.push("inline", "", 0);
      inline.content = trailing.trim();
      inline.children = [];
    }
    state.line = startLine + 1;
    return true;
  };
  parser.block.ruler.before("html_block", "hui_details", rule, { alt: ["paragraph", "reference", "blockquote"] });
  parser.core.ruler.after("block", "hui_details_balance", (state) => {
    let depth = 0;
    for (const token of state.tokens) {
      if (token.type === "details_open") depth += 1;
      else if (token.type === "details_close") depth = Math.max(0, depth - 1);
    }
    while (depth > 0) {
      const token = new state.Token("details_close", "details", -1);
      token.block = true;
      state.tokens.push(token);
      depth -= 1;
    }
  });
  parser.renderer.rules.details_open = (tokens, index) => tokens[index]?.attrGet("open") === null ? "<details>" : "<details open>";
  parser.renderer.rules.details_close = () => "</details>\n";
  parser.renderer.rules.summary_open = () => "<summary>";
  parser.renderer.rules.summary_close = () => "</summary>";
}

function isEscaped(source: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source.charAt(cursor) === "\\"; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function installMath(parser: MarkdownItParser): void {
  parser.block.ruler.before("fence", "hui_math_block", (state, startLine, endLine, silent) => {
    const start = (state.bMarks[startLine] ?? 0) + (state.tShift[startLine] ?? 0);
    const end = state.eMarks[startLine] ?? state.src.length;
    const first = state.src.slice(start, end).trim();
    if (!first.startsWith("$$")) return false;

    let content = "";
    let nextLine = startLine + 1;
    if (first.length > 4 && first.endsWith("$$")) {
      content = first.slice(2, -2).trim();
    } else if (first === "$$") {
      const lines: string[] = [];
      let foundClose = false;
      while (nextLine < endLine) {
        const lineStart = (state.bMarks[nextLine] ?? 0) + (state.tShift[nextLine] ?? 0);
        const lineEnd = state.eMarks[nextLine] ?? state.src.length;
        const line = state.src.slice(lineStart, lineEnd);
        if (line.trim() === "$$") {
          foundClose = true;
          nextLine += 1;
          break;
        }
        lines.push(line);
        nextLine += 1;
      }
      if (!foundClose) return false;
      content = lines.join("\n").trim();
    } else {
      return false;
    }
    if (!content) return false;
    if (silent) return true;
    const token = state.push("hui_math_block", "hui-math", 0);
    token.block = true;
    token.content = content;
    token.map = [startLine, nextLine];
    state.line = nextLine;
    return true;
  });

  parser.inline.ruler.before("escape", "hui_math_inline", (state: StateInline, silent: boolean) => {
    const start = state.pos;
    if (state.src.charAt(start) !== "$" || state.src.charAt(start + 1) === "$" || isEscaped(state.src, start)) return false;
    if (!state.src.charAt(start + 1) || /\s/u.test(state.src.charAt(start + 1))) return false;
    for (let cursor = start + 1; cursor < state.posMax; cursor += 1) {
      if (state.src.charAt(cursor) !== "$" || isEscaped(state.src, cursor)) continue;
      if (cursor === start + 1 || /\s/u.test(state.src.charAt(cursor - 1))) continue;
      if (/\d/u.test(state.src.charAt(cursor + 1))) continue;
      if (!silent) {
        const token = state.push("hui_math_inline", "hui-math", 0);
        token.content = state.src.slice(start + 1, cursor);
      }
      state.pos = cursor + 1;
      return true;
    }
    return false;
  });

  parser.renderer.rules.hui_math_block = (tokens, index) => `<hui-math class="markdown-math markdown-math--block" data-display="block" role="math" tabindex="0"><template>${escapeHtml(tokens[index]?.content ?? "")}</template></hui-math>\n`;
  parser.renderer.rules.hui_math_inline = (tokens, index) => `<hui-math class="markdown-math markdown-math--inline" data-display="inline" role="math"><template>${escapeHtml(tokens[index]?.content ?? "")}</template></hui-math>`;
}

function installAlerts(parser: MarkdownItParser): void {
  parser.core.ruler.after("inline", "hui_markdown_alerts", (state) => {
    for (let index = 0; index < state.tokens.length; index += 1) {
      const open = state.tokens[index];
      if (open?.type !== "blockquote_open") continue;
      let depth = 1;
      let firstInline: Token | undefined;
      let closeIndex = -1;
      for (let cursor = index + 1; cursor < state.tokens.length; cursor += 1) {
        const token = state.tokens[cursor];
        if (token?.type === "blockquote_open") depth += 1;
        else if (token?.type === "blockquote_close") {
          depth -= 1;
          if (depth === 0) { closeIndex = cursor; break; }
        } else if (depth === 1 && !firstInline && token?.type === "inline") {
          firstInline = token;
        }
      }
      const firstChild = firstInline?.children?.find((token) => token.type === "text" && token.content.trim());
      const match = firstChild?.content.match(ALERT_MARKER_RE);
      if (!firstInline?.children || !firstChild || !match || closeIndex < 0) continue;
      const type = match[1]?.toLowerCase() as AlertType;
      firstChild.content = firstChild.content.replace(ALERT_MARKER_RE, "");
      while (firstInline.children[0]?.type === "text" && !firstInline.children[0].content) firstInline.children.shift();
      if (firstInline.children[0]?.type === "softbreak") firstInline.children.shift();
      open.meta = { ...(open.meta ?? {}), huiAlert: type };
      const close = state.tokens[closeIndex];
      if (close) close.meta = { ...(close.meta ?? {}), huiAlert: type };
    }
  });
  parser.renderer.rules.blockquote_open = (tokens, index, options, _env, self) => {
    const type = tokens[index]?.meta?.huiAlert as AlertType | undefined;
    if (!type) return self.renderToken(tokens, index, options);
    return `<aside class="markdown-alert markdown-alert--${type}" aria-label="${ALERT_LABELS[type]}"><div class="markdown-alert__title">${ALERT_LABELS[type]}</div><div class="markdown-alert__body">`;
  };
  parser.renderer.rules.blockquote_close = (tokens, index, options, _env, self) => tokens[index]?.meta?.huiAlert
    ? "</div></aside>\n"
    : self.renderToken(tokens, index, options);
}

function linkLabel(children: readonly Token[], openIndex: number): Token | undefined {
  for (let index = openIndex + 1; index < children.length; index += 1) {
    const token = children[index];
    if (!token || token.type === "link_close") return undefined;
    if ((token.type === "text" || token.type === "code_inline") && token.content.trim()) return token;
  }
  return undefined;
}

function installLinkRules(parser: MarkdownItParser): void {
  parser.linkify.set({ fuzzyLink: false });
  parser.linkify.add("www", {
    validate(text, pos) {
      const match = text.slice(pos).match(/^\.(?:[a-zA-Z0-9-]+\.?)+[^\s<\u2e80-\u2fff\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff01-\uff60]*/);
      if (!match) return 0;
      const tail = match[0];
      let length = tail.length;
      const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{", '"': '"', "'": "'" };
      const balance: Record<string, number> = {};
      for (const [close, open] of Object.entries(pairs)) {
        balance[close] = 0;
        for (let index = 0; index < length; index += 1) {
          const character = tail.charAt(index);
          if (open === close && character === open) balance[close] = balance[close] === 0 ? 1 : 0;
          else if (character === open) balance[close] = (balance[close] ?? 0) + 1;
          else if (character === close) balance[close] = (balance[close] ?? 0) - 1;
        }
      }
      while (length > 0) {
        const character = tail.charAt(length - 1);
        if (/[?!.,:*_~]/.test(character)) { length -= 1; continue; }
        if (character === ";") {
          let index = length - 2;
          while (index >= 0 && /[a-zA-Z0-9]/.test(tail.charAt(index))) index -= 1;
          if (index >= 0 && tail.charAt(index) === "&" && index < length - 2) { length = index; continue; }
          break;
        }
        const open = pairs[character];
        if (open !== undefined) {
          if (open === character && (balance[character] ?? 0) !== 0) {
            balance[character] = 0;
            length -= 1;
            continue;
          }
          if (open !== character && (balance[character] ?? 0) < 0) {
            balance[character] = (balance[character] ?? 0) + 1;
            length -= 1;
            continue;
          }
        }
        break;
      }
      return length;
    },
    normalize(match) { match.url = `http://${match.url}`; },
  });
  parser.validateLink = () => true;
  parser.core.ruler.after("linkify", "hui_safe_links", (state) => {
    for (const block of state.tokens) {
      if (block.type !== "inline" || !block.children) continue;
      const children = block.children;
      let hideClose = false;
      for (let index = 0; index < children.length; index += 1) {
        let token = children[index];
        if (!token) continue;
        if (token.type === "code_inline" && /^https?:\/\/(?:www\.)?github\.com\/\S+$/i.test(token.content)) {
          const open = new state.Token("link_open", "a", 1);
          open.markup = "code-span-url";
          open.attrSet("href", token.content);
          const label = new state.Token("text", "", 0);
          label.content = token.content;
          const close = new state.Token("link_close", "a", -1);
          children.splice(index, 1, open, label, close);
          token = open;
        }
        if (token.type === "link_open") {
          const href = String(token.attrGet("href") ?? "");
          if (DISALLOWED_LINK_SCHEME_RE.test(href)) {
            token.hidden = true;
            hideClose = true;
            continue;
          }
          let url: URL | undefined;
          try { url = new URL(href); } catch { /* Relative hrefs stay valid. */ }
          if (url?.protocol === "http:" || url?.protocol === "https:") {
            token.attrSet("target", "_blank");
            token.attrSet("rel", "noreferrer noopener");
            const generated = ["linkify", "autolink", "code-span-url"].includes(token.markup);
            if (generated) token.attrJoin("class", "markdown-bare-url");
            if (["github.com", "www.github.com"].includes(url.hostname.toLowerCase())) {
              token.attrJoin("class", "markdown-github-link");
              const label = linkLabel(children, index);
              if (generated && label) {
                const segments = url.pathname.split("/").filter(Boolean);
                label.content = segments.length === 2 ? segments.join("/") : ["github.com", ...segments.slice(2)].join("/");
                token.attrSet("title", href);
              }
            }
          }
        } else if (token.type === "link_close" && hideClose) {
          token.hidden = true;
          hideClose = false;
        }
      }
    }
  });
  parser.core.ruler.after("linkify", "hui_cjk_link_trim", (state) => {
    for (const block of state.tokens) {
      const children = block.children;
      if (block.type !== "inline" || !children) continue;
      for (let index = 0; index < children.length; index += 1) {
        const open = children[index];
        const label = children[index + 1];
        if (open?.type !== "link_open" || open.markup !== "linkify" || label?.type !== "text") continue;
        let boundary = label.content.length;
        while (boundary > 0 && CJK_RE.test(label.content.charAt(boundary - 1))) boundary -= 1;
        if (boundary === 0 || boundary === label.content.length) continue;
        const tail = label.content.slice(boundary);
        const visible = label.content.slice(0, boundary);
        const href = String(open.attrGet("href") ?? "");
        const prefix = href.endsWith(label.content) ? href.slice(0, -label.content.length) : "";
        open.attrSet("href", prefix + visible);
        label.content = visible;
        const closeIndex = children.findIndex((token, cursor) => cursor > index && token.type === "link_close");
        if (closeIndex > index) {
          const suffix = new state.Token("text", "", 0);
          suffix.content = tail;
          children.splice(closeIndex + 1, 0, suffix);
        }
      }
    }
  });
}

function tweetIdFromUrl(raw: string): string | undefined {
  let url: URL;
  try { url = new URL(raw); } catch { return undefined; }
  const host = url.hostname.toLowerCase().replace(/^www\./u, "");
  if (url.protocol !== "https:" || (host !== "x.com" && host !== "twitter.com")) return undefined;
  const match = url.pathname.match(/^\/[A-Za-z0-9_]+\/status\/(\d+)(?:\/)?$/u);
  return match?.[1];
}

function installRichEmbeds(parser: MarkdownItParser): void {
  parser.core.ruler.after("hui_safe_links", "hui_rich_url_embeds", (state) => {
    for (let index = 0; index < state.tokens.length - 2; index += 1) {
      const open = state.tokens[index];
      const inline = state.tokens[index + 1];
      const close = state.tokens[index + 2];
      if (open?.type !== "paragraph_open" || inline?.type !== "inline" || close?.type !== "paragraph_close") continue;
      const children = inline.children?.filter((token) => token.type !== "text" || token.content.trim()) ?? [];
      if (children.length !== 3) continue;
      const [linkOpen, label, linkClose] = children;
      if (linkOpen?.type !== "link_open" || label?.type !== "text" || linkClose?.type !== "link_close") continue;
      if (!["autolink", "linkify"].includes(linkOpen.markup)) continue;
      const href = String(linkOpen.attrGet("href") ?? "");
      const tweetId = tweetIdFromUrl(href);
      const embed = new state.Token("html_inline", "", 0);
      const slack = parseSlackLink(href);
      if (tweetId) {
        embed.content = `<hui-tweet-embed data-tweet-id="${tweetId}" data-url="${escapeHtml(href)}"></hui-tweet-embed>`;
      } else if (slack) {
        embed.content = `<hui-slack-link data-url="${escapeHtml(slack.url)}" data-workspace="${escapeHtml(slack.workspace)}" data-channel-id="${escapeHtml(slack.channelId)}" data-kind="${slack.kind}"></hui-slack-link>`;
      } else {
        continue;
      }
      embed.meta = { richEmbed: true };
      inline.children = [embed];
      open.meta = { richEmbed: true };
      close.meta = { richEmbed: true };
    }
  });
  parser.renderer.rules.paragraph_open = (tokens, index) => tokens[index]?.hidden || tokens[index]?.meta?.richEmbed === true ? "" : "<p>";
  parser.renderer.rules.paragraph_close = (tokens, index) => tokens[index]?.hidden || tokens[index]?.meta?.richEmbed === true ? "" : "</p>\n";
}

function fileReferenceTag(state: StateCore, reference: FileReference | undefined): Token {
  const token = new state.Token("html_inline", "", 0);
  token.meta = { fileRef: true };
  token.content = reference
    ? `<hui-file-ref data-path="${escapeHtml(reference.path)}"${reference.line ? ` data-line="${reference.line}"` : ""}${reference.column ? ` data-column="${reference.column}"` : ""}>`
    : "</hui-file-ref>";
  return token;
}

/** Wraps path-shaped inline code spans and link targets in `<hui-file-ref>`. A link's label is wrapped whole and its
 * own code spans are left alone; web and mail links stay links. */
function installFileReferences(parser: MarkdownItParser): void {
  parser.core.ruler.after("hui_safe_links", "hui_file_references", (state) => {
    for (const block of state.tokens) {
      if (block.type !== "inline" || !block.children) continue;
      const children = block.children;
      const links: boolean[] = [];
      for (let index = 0; index < children.length; index += 1) {
        const token = children[index];
        if (!token) continue;
        if (token.type === "link_open") {
          const href = String(token.attrGet("href") ?? "");
          const reference = /^(?:https?|mailto):/iu.test(href) ? undefined : parseFileLinkTarget(href);
          links.push(Boolean(reference));
          if (reference) children[index] = fileReferenceTag(state, reference);
        } else if (token.type === "link_close") {
          if (links.pop()) children[index] = fileReferenceTag(state, undefined);
        } else if (token.type === "code_inline" && !links.length) {
          const reference = parseFileReference(token.content);
          if (!reference) continue;
          children.splice(index, 1, fileReferenceTag(state, reference), token, fileReferenceTag(state, undefined));
          index += 2;
        }
      }
    }
  });
}

export type MarkdownParserOptions = {
  /** Wrap file references for the Files view (the agent's replies only). */
  fileReferences?: boolean;
  /** `false` keeps isolated Slack and X links as links instead of cards. */
  linkCards?: boolean;
};

export function createMarkdownParser(options: MarkdownParserOptions = {}): MarkdownItParser {
  const parser = new MarkdownIt({ html: true, breaks: true, linkify: true });
  parser.use(markdownItCjkFriendly);
  parser.enable("strikethrough");
  installDetails(parser);
  installMath(parser);
  installLinkRules(parser);
  if (options.fileReferences) installFileReferences(parser);
  installRichEmbeds(parser);
  if (options.linkCards === false) parser.core.ruler.disable("hui_rich_url_embeds");
  installAlerts(parser);
  parser.use(markdownItTaskLists, { enabled: false, label: false });

  parser.core.ruler.after("github-task-lists", "hui_task_list_allowlist", (state) => {
    for (const [index, item] of state.tokens.entries()) {
      if (item.type !== "list_item_open" || item.attrGet("class") !== "task-list-item") continue;
      const checkbox = state.tokens[index + 2]?.children?.[0];
      if (checkbox?.type === "html_inline") checkbox.meta = { taskListPlugin: true };
    }
  });
  parser.renderer.rules.html_block = (tokens, index) => {
    const value = tokens[index]?.content ?? "";
    return /^<br\s*\/?>$/iu.test(value.trim()) ? "<br>\n" : `${escapeHtml(value)}\n`;
  };
  parser.renderer.rules.html_inline = (tokens, index) => {
    const token = tokens[index];
    if (token?.meta?.taskListPlugin === true || token?.meta?.richEmbed === true || token?.meta?.fileRef === true) return token.content;
    return /^<br\s*\/?>$/iu.test(token?.content.trim() ?? "") ? "<br>" : escapeHtml(token?.content ?? "");
  };
  parser.renderer.rules.table_open = () => '<div class="markdown-table"><div class="markdown-table__viewport" tabindex="0" role="region" aria-label="Table"><table>';
  parser.renderer.rules.table_close = () => "</table></div></div>";
  parser.renderer.rules.th_open = (tokens, index) => {
    const style = tokens[index]?.attrGet("style");
    return `<th scope="col"${style ? ` style="${escapeHtml(String(style))}"` : ""}>`;
  };
  parser.renderer.rules.image = (tokens, index) => {
    const token = tokens[index];
    if (!token) return "";
    const src = String(token.attrGet("src") ?? "");
    const alt = token.content.trim() || "image";
    if (INLINE_DATA_IMAGE_RE.test(src)) {
      return `<button type="button" class="markdown-image-button" data-media-viewer aria-label="Open image: ${escapeHtml(alt)}"><img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}"></button>`;
    }
    if (/^https?:\/\//i.test(src)) return `<span class="markdown-external-image"><span>External image not loaded: ${escapeHtml(alt)}</span> <a href="${escapeHtml(src)}" target="_blank" rel="noreferrer noopener">Open image</a></span>`;
    return escapeHtml(alt);
  };
  parser.renderer.rules.fence = (tokens, index) => {
    const token = tokens[index];
    const language = token?.info.trim().split(/\s+/u)[0]?.toLowerCase();
    if (language === "mermaid") {
      return `<hui-mermaid class="markdown-mermaid" role="figure" aria-label="Mermaid diagram" tabindex="0"><template>${escapeHtml(token?.content ?? "")}</template></hui-mermaid>`;
    }
    if (["chart", "vega-lite", "vegalite"].includes(language ?? "")) {
      return `<hui-vega-chart class="markdown-vega-chart" role="figure" aria-label="Data chart" tabindex="0"><template>${escapeHtml(token?.content ?? "")}</template></hui-vega-chart>`;
    }
    return token ? renderCodeBlock(token.content, token.info) : "";
  };
  parser.renderer.rules.code_block = (tokens, index) => {
    const token = tokens[index];
    return token ? renderCodeBlock(token.content, "") : "";
  };
  return parser;
}

const markdownParser = createMarkdownParser();

/** Sources retained before the cache is dropped entirely. A long transcript is
 * a few hundred Markdown strings, so one session's worth fits comfortably. */
const CACHE_LIMIT = 2_000;

/** Memoises one parse per distinct source. Lit re-runs the whole template on
 * every update — each keystroke in the composer, each streamed token and the
 * 3s session poll — so an uncached parse would repeat the entire transcript's
 * Markdown work every time any of those happens.
 *
 * `parse` is a parameter so the memoisation contract itself is testable. */
export function createMarkdownCache(
  parse: (source: string) => string = (source) => markdownParser.render(source),
): (source: string) => string {
  const cache = new Map<string, string>();
  return (source) => {
    const cached = cache.get(source);
    if (cached !== undefined) return cached;
    const html = parse(source);
    // ponytail: clear-all eviction, bounded by CACHE_LIMIT; per-entry LRU only
    // if a workload larger than that shows a measurable hit-rate loss.
    if (cache.size >= CACHE_LIMIT) cache.clear();
    cache.set(source, html);
    return html;
  };
}

export const markdownToHtml = createMarkdownCache();

export function renderMarkdown(source: string) {
  return unsafeHTML(markdownToHtml(source));
}

const agentMarkdownParser = createMarkdownParser({ fileReferences: true });
const agentLinksParser = createMarkdownParser({ fileReferences: true, linkCards: false });

/** The agent's replies: `markdownToHtml` plus file references (see the module header). */
export const agentMarkdownToHtml = createMarkdownCache((source) => agentMarkdownParser.render(source));
const agentLinksToHtml = createMarkdownCache((source) => agentLinksParser.render(source));

export function renderAgentMarkdown(source: string, linkCards = false) {
  return unsafeHTML((linkCards ? agentMarkdownToHtml : agentLinksToHtml)(source));
}

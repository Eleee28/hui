/**
 * Conversion between Jira Cloud's Atlassian Document Format (ADF) and the small
 * Markdown subset HUI renders. Reading covers the node types Jira descriptions
 * commonly contain; writing covers what the drafting agent produces (headings,
 * paragraphs, lists, fenced code, quotes and simple inline marks). Anything
 * unknown degrades to its text content instead of failing.
 */

type AdfNode = {
  type?: unknown;
  text?: unknown;
  attrs?: Record<string, unknown>;
  marks?: { type?: unknown; attrs?: Record<string, unknown> }[];
  content?: unknown;
};

const MAX_DEPTH = 24;

function children(node: AdfNode): AdfNode[] {
  return Array.isArray(node.content) ? (node.content as AdfNode[]).filter((child) => child && typeof child === "object") : [];
}

function inlineText(node: AdfNode): string {
  switch (node.type) {
    case "text": {
      let text = typeof node.text === "string" ? node.text : "";
      if (!text) return "";
      const marks = Array.isArray(node.marks) ? node.marks : [];
      const has = (type: string) => marks.some((mark) => mark?.type === type);
      if (has("code")) return `\`${text.replace(/`/gu, "'")}\``;
      if (has("strong")) text = `**${text}**`;
      if (has("em")) text = `*${text}*`;
      if (has("strike")) text = `~~${text}~~`;
      const link = marks.find((mark) => mark?.type === "link")?.attrs?.["href"];
      if (typeof link === "string" && /^https?:\/\//iu.test(link)) text = `[${text}](${link})`;
      return text;
    }
    case "hardBreak": return "\n";
    case "mention": return typeof node.attrs?.["text"] === "string" ? String(node.attrs["text"]) : "@user";
    case "emoji": return typeof node.attrs?.["text"] === "string" ? String(node.attrs["text"]) : String(node.attrs?.["shortName"] ?? "");
    case "date": {
      const stamp = Number(node.attrs?.["timestamp"]);
      return Number.isFinite(stamp) ? new Date(stamp).toISOString().slice(0, 10) : "";
    }
    case "status": return typeof node.attrs?.["text"] === "string" ? `[${String(node.attrs["text"])}]` : "";
    case "inlineCard":
    case "blockCard":
    case "embedCard": {
      const url = node.attrs?.["url"];
      return typeof url === "string" ? url : "";
    }
    default: return children(node).map(inlineText).join("");
  }
}

function blockMarkdown(node: AdfNode, depth: number): string {
  if (depth > MAX_DEPTH) return "";
  const inline = () => children(node).map(inlineText).join("");
  switch (node.type) {
    case "doc": return children(node).map((child) => blockMarkdown(child, depth + 1)).filter(Boolean).join("\n\n");
    case "paragraph": return inline();
    case "heading": {
      const level = Math.min(6, Math.max(1, Number(node.attrs?.["level"]) || 1));
      return `${"#".repeat(level)} ${inline()}`;
    }
    case "bulletList":
    case "orderedList": {
      const ordered = node.type === "orderedList";
      const start = Math.max(1, Number(node.attrs?.["order"]) || 1);
      return children(node).map((item, index) => {
        const marker = ordered ? `${start + index}. ` : "- ";
        const body = children(item).map((child) => blockMarkdown(child, depth + 1)).filter(Boolean).join("\n");
        return `${marker}${body.replace(/\n/gu, `\n${" ".repeat(marker.length)}`)}`;
      }).join("\n");
    }
    case "taskList":
      return children(node).map((item) => `- [${item.attrs?.["state"] === "DONE" ? "x" : " "}] ${children(item).map(inlineText).join("")}`).join("\n");
    case "codeBlock": {
      const language = typeof node.attrs?.["language"] === "string" ? String(node.attrs["language"]) : "";
      return `\`\`\`${language}\n${children(node).map((child) => (typeof child.text === "string" ? child.text : "")).join("")}\n\`\`\``;
    }
    case "blockquote":
      return children(node).map((child) => blockMarkdown(child, depth + 1)).join("\n\n").split("\n").map((line) => `> ${line}`).join("\n");
    case "panel":
    case "expand":
    case "nestedExpand":
    case "layoutSection":
    case "layoutColumn":
      return children(node).map((child) => blockMarkdown(child, depth + 1)).filter(Boolean).join("\n\n");
    case "rule": return "---";
    case "table": {
      const rows = children(node).map((row) => children(row).map((cell) =>
        children(cell).map((child) => blockMarkdown(child, depth + 1)).join(" ").replace(/\|/gu, "\\|").replace(/\n+/gu, " ")));
      if (!rows.length) return "";
      const width = Math.max(...rows.map((row) => row.length));
      const line = (row: string[]) => `| ${Array.from({ length: width }, (_, index) => row[index] ?? "").join(" | ")} |`;
      return [line(rows[0]!), `|${" --- |".repeat(width)}`, ...rows.slice(1).map(line)].join("\n");
    }
    case "mediaSingle":
    case "mediaGroup":
    case "media": return "";
    default: return inline();
  }
}

/** Markdown for a Jira description. Plain strings (Jira REST v2) pass through. */
export function adfToMarkdown(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  return blockMarkdown(value as AdfNode, 0).replace(/\n{3,}/gu, "\n\n").trim();
}

type AdfMark = { type: string; attrs?: Record<string, string> };
export type AdfOut = { version?: 1; type: string; text?: string; marks?: AdfMark[]; attrs?: Record<string, unknown>; content?: AdfOut[] };

const INLINE = /(\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*([^*]+)\*)/gu;

function inlineNodes(text: string): AdfOut[] {
  const nodes: AdfOut[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    if (match.index > last) nodes.push({ type: "text", text: text.slice(last, match.index) });
    if (match[2] !== undefined) nodes.push({ type: "text", text: match[2], marks: [{ type: "strong" }] });
    else if (match[3] !== undefined) nodes.push({ type: "text", text: match[3], marks: [{ type: "code" }] });
    else if (match[4] !== undefined) nodes.push({ type: "text", text: match[4], marks: [{ type: "link", attrs: { href: match[5]! } }] });
    else if (match[6] !== undefined) nodes.push({ type: "text", text: match[6], marks: [{ type: "em" }] });
    last = match.index + match[0].length;
  }
  if (last < text.length) nodes.push({ type: "text", text: text.slice(last) });
  return nodes.filter((node) => node.text);
}

function paragraph(lines: string[]): AdfOut {
  const content: AdfOut[] = [];
  lines.forEach((line, index) => {
    if (index > 0) content.push({ type: "hardBreak" });
    content.push(...inlineNodes(line));
  });
  return { type: "paragraph", content };
}

/** ADF document for a Markdown description written by the operator or agent. */
export function markdownToAdf(markdown: string): AdfOut {
  const lines = markdown.replace(/\r\n?/gu, "\n").split("\n");
  const content: AdfOut[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (!line.trim()) { index += 1; continue; }
    const fence = line.match(/^```\s*([\w+-]*)\s*$/u);
    if (fence) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/u.test(lines[index]!)) body.push(lines[index++]!);
      index += 1;
      content.push({ type: "codeBlock", ...(fence[1] ? { attrs: { language: fence[1] } } : {}), content: body.length ? [{ type: "text", text: body.join("\n") }] : [] });
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/u);
    if (heading) {
      content.push({ type: "heading", attrs: { level: heading[1]!.length }, content: inlineNodes(heading[2]!.trim()) });
      index += 1;
      continue;
    }
    if (/^\s*(?:-{3,}|\*{3,})\s*$/u.test(line)) { content.push({ type: "rule" }); index += 1; continue; }
    const list = line.match(/^\s*([-*]|\d+[.)])\s+/u);
    if (list) {
      const ordered = /\d/u.test(list[1]!);
      const items: AdfOut[] = [];
      while (index < lines.length) {
        const item = lines[index]!.match(/^\s*([-*]|\d+[.)])\s+(.*)$/u);
        if (!item || /\d/u.test(item[1]!) !== ordered) break;
        items.push({ type: "listItem", content: [paragraph([item[2]!.replace(/^\[[ xX]\]\s+/u, "")])] });
        index += 1;
      }
      content.push({ type: ordered ? "orderedList" : "bulletList", content: items });
      continue;
    }
    if (line.startsWith(">")) {
      const quoted: string[] = [];
      while (index < lines.length && lines[index]!.startsWith(">")) quoted.push(lines[index++]!.replace(/^>\s?/u, ""));
      content.push({ type: "blockquote", content: [paragraph(quoted)] });
      continue;
    }
    const block: string[] = [];
    while (index < lines.length && lines[index]!.trim() && !/^(```|#{1,6}\s|>|\s*([-*]|\d+[.)])\s+)/u.test(lines[index]!)) block.push(lines[index++]!);
    content.push(paragraph(block));
  }
  return { version: 1, type: "doc", content };
}

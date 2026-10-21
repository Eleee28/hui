/** Recognises canonical Slack conversation links for inline previews. Parsing only; it never contacts Slack. */
export interface SlackLinkPreview {
  url: string;
  workspace: string;
  channelId: string;
  kind: "channel" | "message";
}

const SLACK_ID_RE = /^[A-Z][A-Z0-9]{7,}$/iu;
const SLACK_MESSAGE_RE = /^p\d{16}$/u;
const SLACK_THREAD_TS_RE = /^\d{10,}\.\d{6}$/u;

/** Parses only canonical Slack conversation links. It never performs network IO. */
export function parseSlackLink(raw: string): SlackLinkPreview | undefined {
  let url: URL;
  try { url = new URL(raw); } catch { return undefined; }
  if (url.protocol !== "https:" || url.username || url.password) return undefined;

  const hostname = url.hostname.toLowerCase();
  const segments = url.pathname.split("/").filter(Boolean);
  if (hostname === "app.slack.com") {
    if (segments[0] !== "client") return undefined;
    const [, workspaceId, channelId] = segments;
    if (!workspaceId || !channelId || !SLACK_ID_RE.test(workspaceId) || !SLACK_ID_RE.test(channelId)) return undefined;
    if (segments.length === 3) return { url: url.href, workspace: workspaceId, channelId, kind: "channel" };
    const thread = segments[4]?.startsWith(`${channelId}-`) ? segments[4].slice(channelId.length + 1) : "";
    if (segments.length === 5 && segments[3] === "thread" && SLACK_THREAD_TS_RE.test(thread)) {
      return { url: url.href, workspace: workspaceId, channelId, kind: "message" };
    }
    return undefined;
  }

  const match = hostname.match(/^([a-z0-9][a-z0-9-]*)\.slack\.com$/u);
  if (!match || segments[0] !== "archives" || !segments[1] || !SLACK_ID_RE.test(segments[1])) return undefined;
  if (segments.length === 2) {
    return { url: url.href, workspace: match[1]!, channelId: segments[1], kind: "channel" };
  }
  if (segments.length === 3 && SLACK_MESSAGE_RE.test(segments[2] ?? "")) {
    return { url: url.href, workspace: match[1]!, channelId: segments[1], kind: "message" };
  }
  return undefined;
}

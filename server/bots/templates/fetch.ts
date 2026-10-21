/**
 * Fetching a Grok Bot marketplace page, only when the operator asks for that link to be imported: https on x.ai, no
 * redirect elsewhere, a timeout and a size cap. A page that can't be fetched is an error that suggests pasting the
 * bot's instructions instead, as is a page whose bot can't be found (`grok.ts`).
 */
import { GROK_PASTE_HINT, grokBotUrl } from "./grok.ts";
import { TemplateFormatError } from "./common.ts";
import { BOT_TEMPLATE_LIMITS } from "./formats.ts";

/** x.ai could not be reached, or refused the page: the routes answer 502 with the message. */
export class TemplateFetchError extends Error {
  override name = "TemplateFetchError";
}

export type FetchPageOptions = { fetch?: typeof fetch; timeoutMs?: number; maxBytes?: number };

const MAX_REDIRECTS = 3;

/** The page's HTML, from its canonical link. */
export async function fetchGrokBotPage(raw: string, options: FetchPageOptions = {}): Promise<string> {
  const start = grokBotUrl(raw);
  if (!start) {
    throw new TemplateFormatError("HUI fetches Grok Bot marketplace links only (https://x.ai/bot/marketplace/bots/…). For anything else, download the file and import it, or paste its text.");
  }
  let url: string = start;
  const fetcher = options.fetch ?? fetch;
  const maxBytes = options.maxBytes ?? BOT_TEMPLATE_LIMITS.pageBytes;
  const signal = AbortSignal.timeout(options.timeoutMs ?? 20_000);
  try {
    for (let redirects = 0; ; redirects += 1) {
      const response: Response = await fetcher(url, {
        redirect: "manual",
        signal,
        headers: { accept: "text/html,application/xhtml+xml", "accept-language": "en", "user-agent": "Mozilla/5.0 (compatible; HUI bot import)" },
      });
      if (response.status >= 300 && response.status < 400) {
        const location: string | null = response.headers.get("location");
        const next: string | undefined = location ? grokBotUrl(new URL(location, url).href) : undefined;
        await response.body?.cancel().catch(() => {});
        if (!next || redirects >= MAX_REDIRECTS) throw new TemplateFetchError(`x.ai sent this page somewhere HUI does not follow. ${GROK_PASTE_HINT}`);
        url = next;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new TemplateFetchError(`x.ai answered HTTP ${response.status} for this page. ${GROK_PASTE_HINT}`);
      }
      if (!/text\/html|application\/xhtml/iu.test(response.headers.get("content-type") ?? "")) {
        await response.body?.cancel().catch(() => {});
        throw new TemplateFetchError(`x.ai did not answer with a web page. ${GROK_PASTE_HINT}`);
      }
      const declared = Number(response.headers.get("content-length") ?? 0);
      if (declared > maxBytes) {
        await response.body?.cancel().catch(() => {});
        throw new TemplateFetchError(`This page is larger than ${Math.round(maxBytes / 1024 / 1024)} MB. ${GROK_PASTE_HINT}`);
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      const reader = response.body?.getReader();
      for (;;) {
        const next = await reader?.read();
        if (!next || next.done) break;
        size += next.value.byteLength;
        if (size > maxBytes) {
          await reader?.cancel().catch(() => {});
          throw new TemplateFetchError(`This page is larger than ${Math.round(maxBytes / 1024 / 1024)} MB. ${GROK_PASTE_HINT}`);
        }
        chunks.push(next.value);
      }
      return Buffer.concat(chunks).toString("utf8");
    }
  } catch (error) {
    if (error instanceof TemplateFetchError || error instanceof TemplateFormatError) throw error;
    const reason = signal.aborted ? "x.ai did not answer in time" : error instanceof Error ? error.message : String(error);
    throw new TemplateFetchError(`HUI could not fetch this page (${reason}). ${GROK_PASTE_HINT}`);
  }
}

import assert from "node:assert/strict";
import { test } from "vitest";
import { TemplateFormatError } from "./common.ts";
import { fetchGrokBotPage, TemplateFetchError } from "./fetch.ts";

const PAGE = "https://x.ai/bot/marketplace/bots/trip-planner";
type Call = { url: string; init?: RequestInit };

function fake(responses: (() => Response)[]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), ...(init ? { init } : {}) });
      const next = responses.shift();
      if (!next) throw new Error("no more responses");
      return next();
    }) as typeof fetch,
  };
}

const html = (body: string, headers: Record<string, string> = {}) => () => new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8", ...headers } });

test("a marketplace page is fetched from its canonical link, without following redirects on its own", async () => {
  const net = fake([html("<html>page</html>")]);
  assert.equal(await fetchGrokBotPage(`${PAGE}/?ref=x`, { fetch: net.fetch }), "<html>page</html>");
  assert.equal(net.calls[0]!.url, PAGE);
  assert.equal(net.calls[0]!.init?.redirect, "manual");
});

test("a redirect is followed only to another marketplace page; anything else, a refusal or a page too large suggests pasting", async () => {
  const moved = fake([() => new Response(null, { status: 301, headers: { location: "https://www.x.ai/bot/marketplace/bots/trip-planner-2" } }), html("<html>moved</html>")]);
  assert.equal(await fetchGrokBotPage(PAGE, { fetch: moved.fetch }), "<html>moved</html>");
  assert.equal(moved.calls[1]!.url, "https://x.ai/bot/marketplace/bots/trip-planner-2");
  const away = fake([() => new Response(null, { status: 302, headers: { location: "https://evil.example/steal" } })]);
  await assert.rejects(fetchGrokBotPage(PAGE, { fetch: away.fetch }), (error: unknown) => error instanceof TemplateFetchError && /somewhere HUI does not follow[\s\S]*paste them instead/u.test(error.message));
  await assert.rejects(fetchGrokBotPage(PAGE, { fetch: fake([() => new Response("no", { status: 403 })]).fetch }), /x\.ai answered HTTP 403 for this page\. Open the bot's page/u);
  await assert.rejects(fetchGrokBotPage(PAGE, { fetch: fake([() => new Response("{}", { headers: { "content-type": "application/json" } })]).fetch }), /did not answer with a web page/u);
  await assert.rejects(fetchGrokBotPage(PAGE, { fetch: fake([html("x".repeat(2048))]).fetch, maxBytes: 1024 }), /larger than/u);
  await assert.rejects(fetchGrokBotPage(PAGE, { fetch: fake([() => { throw new Error("getaddrinfo ENOTFOUND x.ai"); }]).fetch }), /could not fetch this page \(getaddrinfo ENOTFOUND x\.ai\)/u);
});

test("any other link is refused before anything is fetched", async () => {
  const net = fake([]);
  await assert.rejects(fetchGrokBotPage("https://example.com/agent.json", { fetch: net.fetch }), TemplateFormatError);
  assert.equal(net.calls.length, 0);
});

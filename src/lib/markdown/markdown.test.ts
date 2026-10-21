import { test } from "vitest";
import assert from "node:assert/strict";
import { agentMarkdownToHtml, createMarkdownCache, markdownToHtml } from "./markdown.ts";

test("renders the Markdown used by agent replies", () => {
  const html = markdownToHtml("# Heading\n\n**bold** and `code`\n\n- one\n- two");
  assert.match(html, /<h1>Heading<\/h1>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<li>one<\/li>/);
});

test("escapes HTML in agent-authored Markdown", () => {
  const html = markdownToHtml('<script>alert("xss")</script>');
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test("renders fenced code as escaped copyable content", () => {
  const html = markdownToHtml("```ts\nconst value = '<safe>';\n```");
  assert.match(html, /data-copy-code/);
  assert.match(html, /class="code-block-wrapper"/);
  assert.match(html, /class="code-block-header"/);
  assert.match(html, /class="code-block-copy" data-copy-code aria-label="Copy code"/);
  assert.match(html, /class="code-block-copy__done"/);
  assert.doesNotMatch(html, /markdown-code__copy/);
  assert.match(html, /class="language-ts"/);
  assert.match(html, /&lt;safe&gt;/);
  assert.doesNotMatch(html, /<safe>/);
});

test("keeps safe links and never emits active javascript links", () => {
  const html = markdownToHtml(
    "[docs](https://example.com/docs) [local](/settings) [bad](javascript:alert(1))",
  );
  assert.match(html, /href="https:\/\/example\.com\/docs"/);
  assert.match(html, /href="\/settings"/);
  assert.doesNotMatch(html, /href="javascript:/);
  assert.match(html, / bad<\/p>/);
});

test("linkifies bare web addresses, www links and email without swallowing punctuation", () => {
  const html = markdownToHtml(
    "Visit https://example.com/docs?q=1, www.example.com/help. Contact test@example.com.",
  );
  assert.match(html, /href="https:\/\/example\.com\/docs\?q=1"/);
  assert.match(html, /class="markdown-bare-url"/);
  assert.match(html, />https:\/\/example\.com\/docs\?q=1<\/a>,/);
  assert.match(html, /href="http:\/\/www\.example\.com\/help"/);
  assert.match(html, /href="mailto:test@example\.com"/);
  assert.doesNotMatch(html, /mailto:test@example\.com\./);
});

test("supports angle autolinks and GitHub presentation while leaving code literal", () => {
  const html = markdownToHtml(
    "<https://example.com> <hello@example.com> https://github.com/openclaw/openclaw `https://code.example`",
  );
  assert.match(html, /^<p><a href="https:\/\/example\.com"/);
  assert.match(html, /href="mailto:hello@example\.com"/);
  assert.match(html, /class="markdown-bare-url markdown-github-link"/);
  assert.match(html, /<code>https:\/\/code\.example<\/code>/);
  assert.equal((html.match(/<a /g) ?? []).length, 3);
});

test("keeps balanced URL punctuation and trims sentence punctuation and CJK suffixes", () => {
  const html = markdownToHtml(
    "See https://example.com/foo(bar). Then https://example.com/path重新解读",
  );
  assert.match(html, /href="https:\/\/example\.com\/foo\(bar\)"/);
  assert.match(html, />https:\/\/example\.com\/foo\(bar\)<\/a>\./);
  assert.match(html, /href="https:\/\/example\.com\/path"/);
  assert.match(html, /<\/a>重新解读/);
});

test("renders GFM task lists with disabled checked and unchecked controls", () => {
  const html = markdownToHtml("- [ ] pending\n- [x] shipped\n- ordinary");
  assert.match(html, /^<ul class="contains-task-list">/);
  assert.match(html, /class="task-list-item-checkbox"[^>]*disabled=""[^>]*> pending/);
  assert.match(html, /class="task-list-item-checkbox"[^>]*checked=""[^>]*disabled=""[^>]*> shipped/);
  assert.match(html, /<li>ordinary<\/li>/);
});

test("code fences retain the original viewport, controls and seven-line preview", () => {
  const code = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n");
  const html = markdownToHtml(`\`\`\`unknown\n${code}\n\`\`\``);
  assert.match(html, /class="code-block-wrapper is-collapsible"/);
  assert.match(html, /class="code-block-viewport"><pre><code class="language-unknown">/);
  assert.match(html, /line 10\n<\/code>/);
  assert.match(html, /class="code-block-wrap" aria-label="Enable word wrap"/);
  assert.match(html, /aria-label="Show 3 hidden lines" aria-expanded="false"/);
  assert.doesNotMatch(markdownToHtml(`\`\`\`text\n${code}\n\`\`\``), /is-collapsible|code-block-expand/);
});

test("quotes preserve paragraph structure and strike-through uses the original element", () => {
  const quote = markdownToHtml("> First line.\n> Second line.\n>\n> Another paragraph.");
  assert.match(quote, /^<blockquote>\n<p>First line\.<br>\nSecond line\.<\/p>/);
  assert.match(quote, /<p>Another paragraph\.<\/p>\n<\/blockquote>\n$/);
  assert.equal(markdownToHtml("~~removed~~"), "<p><s>removed</s></p>\n");
});

test("renders compact pipe tables with inline formatting and column alignment", () => {
  const html = markdownToHtml("Programs:\n| Program | Times | Note |\n|:--|--:|:-:|\n| `confetti` | 23 | **most** |\n| rapid | 19 | [docs](https://example.com) |\n\nAfter.");
  assert.match(html, /<p>Programs:<\/p>\n<div class="markdown-table">/);
  assert.match(html, /tabindex="0" role="region" aria-label="Table"/);
  assert.match(html, /<th scope="col" style="text-align:right">Times<\/th>/);
  assert.match(html, /<td style="text-align:left"><code>confetti<\/code><\/td>/);
  assert.match(html, /<td style="text-align:center"><strong>most<\/strong><\/td>/);
  assert.match(html, /href="https:\/\/example.com"/);
  assert.match(html, /<p>After\.<\/p>\n$/);
});

test("tables allow optional outer pipes, escaped pipes and uneven body rows", () => {
  const html = markdownToHtml("Name | Value\n--- | ---\n`a\\|b` | left\\|right\nshort |\nextra | kept | ignored");
  assert.match(html, /<code>a\|b<\/code>/);
  assert.match(html, />left\|right<\/td>/);
  assert.match(html, />short<\/td>\n<td><\/td>/);
  assert.doesNotMatch(html, /ignored/);
  assert.equal((html.match(/<td(?: |\>)/g) ?? []).length, 6);
  assert.match(markdownToHtml("| Name |\n| --- |\n| last\\|"), />last\|<\/td>/);
});

test("table recognition rejects malformed headers and stays out of fences", () => {
  for (const source of ["a | b\n- | nope", "a | b\n| - |", "a | b\n| -", "plain | text"]) {
    assert.doesNotMatch(markdownToHtml(source), /<table>/);
  }
  assert.doesNotMatch(markdownToHtml("```md\n| a | b |\n| --- | --- |\n```"), /<table>/);
  assert.match(markdownToHtml("> a | b\n> --- | ---\n> 1 | 2"), /<blockquote>\n<div class="markdown-table">/);
  assert.match(markdownToHtml("a | b\n--- | ---\n1 | 2\n# Next"), /<h1>Next<\/h1>\n$/);
});

test("table cells escape HTML and disallow active links", () => {
  const html = markdownToHtml('| <img src=x onerror=alert(1)> | Link |\n| --- | --- |\n| <script>x</script> | [bad](javascript:alert) |');
  assert.doesNotMatch(html, /<img|<script|href="javascript:/);
  assert.match(html, /&lt;img/);
  assert.match(html, /&lt;script&gt;/);
});

test("incomplete streamed tables become tables only when the delimiter is valid", () => {
  const header = "| Program | Times |\n";
  assert.doesNotMatch(markdownToHtml(header + "| --- |"), /<table>/);
  assert.match(markdownToHtml(header + "| --- | --- |"), /<table>/);
  assert.match(markdownToHtml(header + "| --- | --- |\n| confetti | 23"), />23<\/td>/);
});

test("supports nested CommonMark lists and OpenClaw disclosure blocks", () => {
  const html = markdownToHtml("<details><summary>More **info**</summary>\n\n- one\n  - nested\n\n</details>");
  assert.match(html, /^<details><summary>More <strong>info<\/strong><\/summary>/);
  assert.match(html, /<li>one\n<ul>\n<li>nested<\/li>/);
  assert.match(html, /<\/ul>\n<\/details>\n$/);
  assert.match(markdownToHtml("<details open>\n<summary>Streaming</summary>\nbody"), /^<details open>/);
  assert.match(markdownToHtml("<details open>\n<summary>Streaming</summary>\nbody"), /<\/details>\n$/);
});

test("escapes raw HTML while allowing line breaks and trusted task controls", () => {
  const html = markdownToHtml("safe<br>line <img src=x onerror=alert(1)>\n\n- [ ] task");
  assert.match(html, /safe<br>line &lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /<input class="task-list-item-checkbox"/);
});

test("blocks remote images, permits inline data images and drops local image sources", () => {
  const html = markdownToHtml("![remote](https://example.com/a.png) ![inline](data:image/png;base64,AAAA) ![local](/a.png)");
  assert.match(html, /External image not loaded: remote/);
  assert.match(html, /href="https:\/\/example\.com\/a\.png"/);
  assert.match(html, /<button type="button" class="markdown-image-button" data-media-viewer aria-label="Open image: inline"><img src="data:image\/png;base64,AAAA" alt="inline"><\/button>/);
  assert.doesNotMatch(html, /src="\/a\.png"/);
  assert.match(html, / local<\/p>/);
});

test("renders Mermaid fences as isolated lazy diagram elements", () => {
  const html = markdownToHtml("```mermaid\nflowchart LR\n  A[Idea] --> B[Model]\n```");
  assert.match(html, /^<hui-mermaid class="markdown-mermaid" role="figure" aria-label="Mermaid diagram" tabindex="0">/);
  assert.match(html, /<template>flowchart LR\n  A\[Idea\] --&gt; B\[Model\]\n<\/template>/);
  assert.doesNotMatch(html, /code-block-wrapper|<svg/i);
});

test("renders Vega-Lite chart fences as isolated lazy chart elements", () => {
  const source = '```chart\n{"data":{"values":[{"x":"A","y":2}]},"mark":"bar"}\n```';
  const html = markdownToHtml(source);
  assert.match(html, /^<hui-vega-chart class="markdown-vega-chart" role="figure" aria-label="Data chart" tabindex="0">/);
  assert.match(html, /<template>\{&quot;data&quot;:\{&quot;values&quot;:\[\{&quot;x&quot;:&quot;A&quot;,&quot;y&quot;:2\}\]\},&quot;mark&quot;:&quot;bar&quot;\}\n<\/template>/);
  assert.doesNotMatch(html, /<svg|code-block-wrapper/iu);
});

test("renders inline and display math without treating ordinary currency as math", () => {
  const html = markdownToHtml("Euler wrote $e^{i\\pi}+1=0$.\n\n$$\n\\int_0^1 x^2 \\, dx = \\frac{1}{3}\n$$\n\nThe price is $56 and the cap is $99.");
  assert.match(html, /<hui-math class="markdown-math markdown-math--inline" data-display="inline" role="math"><template>e\^\{i\\pi\}\+1=0<\/template><\/hui-math>/u);
  assert.match(html, /<hui-math class="markdown-math markdown-math--block" data-display="block" role="math" tabindex="0"><template>\\int_0\^1 x\^2 \\, dx = \\frac\{1\}\{3\}<\/template><\/hui-math>/u);
  assert.match(html, /The price is \$56 and the cap is \$99\./u);
});

test("renders GitHub-style alert blockquotes and preserves ordinary quotes", () => {
  const html = markdownToHtml("> [!WARNING]\n> Check **the inputs**.\n\n> Ordinary quote");
  assert.match(html, /<aside class="markdown-alert markdown-alert--warning" aria-label="Warning">/u);
  assert.match(html, /<div class="markdown-alert__title">Warning<\/div>/u);
  assert.match(html, /Check <strong>the inputs<\/strong>\./u);
  assert.match(html, /<blockquote>\n<p>Ordinary quote<\/p>\n<\/blockquote>/u);
});

test("embeds only isolated bare X post URLs and keeps other link forms ordinary", () => {
  const bare = markdownToHtml("https://x.com/openai/status/123456789");
  assert.match(bare, /^<hui-tweet-embed data-tweet-id="123456789" data-url="https:\/\/x\.com\/openai\/status\/123456789"><\/hui-tweet-embed>$/);
  assert.doesNotMatch(bare, /<p>/);

  const twitter = markdownToHtml("<https://twitter.com/example/status/42>");
  assert.match(twitter, /data-tweet-id="42"/);
  assert.match(twitter, /data-url="https:\/\/twitter\.com\/example\/status\/42"/);

  for (const source of [
    "See https://x.com/openai/status/123456789 for context.",
    "[Read the post](https://x.com/openai/status/123456789)",
    "https://x.com/openai",
    "http://x.com/openai/status/123456789",
  ]) {
    assert.doesNotMatch(markdownToHtml(source), /<hui-tweet-embed/);
  }
});

test("embeds isolated Slack conversation links without resolving private content", () => {
  const message = markdownToHtml("https://acme.slack.com/archives/C01234567/p1723456789012345");
  assert.match(message, /^<hui-slack-link data-url="https:\/\/acme\.slack\.com\/archives\/C01234567\/p1723456789012345"/u);
  assert.match(message, /data-workspace="acme" data-channel-id="C01234567" data-kind="message"><\/hui-slack-link>$/u);
  assert.doesNotMatch(message, /<p>/u);

  const channel = markdownToHtml("<https://app.slack.com/client/T01234567/C01234567>");
  assert.match(channel, /data-workspace="T01234567" data-channel-id="C01234567" data-kind="channel"/u);

  for (const source of [
    "See https://acme.slack.com/archives/C01234567 for context.",
    "[Open the channel](https://acme.slack.com/archives/C01234567)",
    "http://acme.slack.com/archives/C01234567",
  ]) assert.doesNotMatch(markdownToHtml(source), /<hui-slack-link/u);
});

test("parses each distinct Markdown source once so re-renders stay cheap", () => {
  const parsed: string[] = [];
  const render = createMarkdownCache((source) => {
    parsed.push(source);
    return `<p>${source}</p>`;
  });

  // A transcript re-renders in full on every keystroke and streamed token.
  for (const source of ["first", "second", "first", "second", "first"]) {
    assert.equal(render(source), `<p>${source}</p>`);
  }
  assert.deepEqual(parsed, ["first", "second"]);
});

test("the Markdown cache stays bounded and still renders evicted sources", () => {
  const render = createMarkdownCache((source) => `<p>${source}</p>`);
  for (let index = 0; index <= 2_000; index += 1) assert.equal(render(`value ${index}`), `<p>value ${index}</p>`);
  // The oldest entries were dropped, and re-rendering one is still correct.
  assert.equal(render("value 0"), "<p>value 0</p>");
  assert.equal(render("value 2000"), "<p>value 2000</p>");
});


test("agent replies wrap path-shaped code spans and link targets as file references, nothing else", () => {
  const html = agentMarkdownToHtml([
    "Edited `src/lib/x.ts:42` and `README.md`; run `npm test`, call `foo()`, bump `1.2.3`, pass `--flag`.",
    "",
    "See [the guide](docs/guide.md#L7), [site](https://example.com/a.ts) and [`code`](src/y.ts).",
    "",
    "Plain prose src/lib/x.ts stays prose.",
    "",
    "```ts",
    "import x from \"src/lib/x.ts\";",
    "```",
  ].join("\n"));
  assert.match(html, /<hui-file-ref data-path="src\/lib\/x\.ts" data-line="42"><code>src\/lib\/x\.ts:42<\/code><\/hui-file-ref>/u);
  assert.match(html, /<hui-file-ref data-path="README\.md"><code>README\.md<\/code><\/hui-file-ref>/u);
  for (const text of ["npm test", "foo()", "1.2.3", "--flag"]) assert.match(html, new RegExp(`(?<!data-path=")<code>${text.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&")}</code>`, "u"));
  assert.equal(html.match(/<hui-file-ref /gu)?.length, 4, "x.ts, README.md, the guide link and the code link");
  assert.match(html, /<hui-file-ref data-path="docs\/guide\.md" data-line="7">the guide<\/hui-file-ref>/u);
  assert.match(html, /<hui-file-ref data-path="src\/y\.ts"><code>code<\/code><\/hui-file-ref>/u, "a link's own code span is not wrapped twice");
  assert.match(html, /<a href="https:\/\/example\.com\/a\.ts" target="_blank"/u);
  assert.match(html, /Plain prose src\/lib\/x\.ts stays prose\./u);
  assert.match(html, /import x from &quot;src\/lib\/x\.ts&quot;;/u);
  assert.doesNotMatch(html, /<a href="docs\/guide\.md/u, "a file link is never a relative page link");
});

test("file references are escaped and absent from other Markdown", () => {
  assert.doesNotMatch(markdownToHtml("Edited `src/lib/x.ts`."), /hui-file-ref/u, "hovercards, previews and user text keep plain code");
  const html = agentMarkdownToHtml("Read [x](file:///srv/app/main.go:3) and [y](javascript:alert(1)).");
  assert.match(html, /<hui-file-ref data-path="\/srv\/app\/main\.go" data-line="3">x<\/hui-file-ref>/u);
  assert.doesNotMatch(html, /javascript:/u);
  assert.match(agentMarkdownToHtml("`a/<b>.ts`"), /<code>a\/&lt;b&gt;\.ts<\/code>/u);
});

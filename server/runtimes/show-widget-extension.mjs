/**
 * HUI-owned presentation tool, modeled on OpenClaw's show_widget. The validated call stays in the conversation's
 * transcript (its arguments and this result); the chat renders it in a sandboxed frame (src/lib/widgets.ts,
 * server/agent-tools/widget-sandbox.ts). Nothing else is stored.
 */
import { Type } from "typebox";
import { validateWidget, WIDGET_CODE_MAX_BYTES, WIDGET_TITLE_MAX_LENGTH } from "./widget-code.mjs";

const kib = (bytes) => Math.max(1, Math.round(bytes / 1024));

export default function showWidgetExtension(pi) {
  pi.registerTool({
    name: "show_widget",
    label: "Show widget",
    description: "Show an interactive HTML or SVG widget inline in this HUI chat. Send a fragment with optional <style> and <script>; HUI renders it live in a sandboxed frame that follows its theme and fits the chat width. Use it when seeing or manipulating a result beats prose: interactive explanations, simulations, UI mockups, small dashboards, explorable diagrams.",
    promptSnippet: "Show an interactive HTML/SVG widget inline in the HUI chat",
    promptGuidelines: [
      "Use show_widget when seeing or interacting with something helps the user more than text: a UI mockup, a simulation, an explorable diagram or a small dashboard. Prefer prose, a Markdown table or a mermaid or chart block when they already explain it, and remember a widget illustrates a change without implementing it in the project.",
      "widget_code is an HTML or SVG fragment with optional <style> and <script>, never a full document, Markdown fence or file path. HUI adds the document, theme, a classless base stylesheet and its bridges. Keep a useful initial state in the markup, scope styles under one root id and fit any width down to 360 px.",
      "Color everything with the theme variables (--surface, --card, --elevated, --text, --text-strong, --muted, --border, --border-strong, --accent, --accent-fill, --accent-fg, --ok, --warn, --danger, --info, --radius, --font-body, --font-mono), keep the background transparent, label controls and honor prefers-reduced-motion.",
      "The frame has no network and cannot reach HUI or this conversation: embed the data you gathered, and draw images locally or use data: URLs. Scripts, styles and fonts may load from cdnjs.cloudflare.com, cdn.jsdelivr.net, esm.sh, unpkg.com, Google Fonts and Bunny Fonts; pin versions.",
      "Inline scripts are syntax-checked: fix the reported line and column and call show_widget again. Runtime errors are shown to the user, not to you, and you cannot read the widget's state. The visualize skill has the full authoring guide.",
    ],
    parameters: Type.Object({
      title: Type.String({ minLength: 1, maxLength: WIDGET_TITLE_MAX_LENGTH, description: "Short card title; do not repeat it inside the widget." }),
      widget_code: Type.String({ minLength: 1, maxLength: WIDGET_CODE_MAX_BYTES, description: "HTML or SVG fragment with optional <style> and <script>, at most 256 KiB; not a full document, Markdown fence or file path." }),
    }),
    async execute(_toolCallId, params) {
      const widget = await validateWidget(params);
      return {
        content: [{
          type: "text",
          text: `Showing "${widget.title}" inline in the HUI chat (${widget.mode === "svg" ? "SVG" : "HTML"}, ${kib(widget.bytes)} KiB). It runs sandboxed, without network or access to HUI and this conversation; you cannot read its state, and runtime errors are shown to the user.`,
        }],
        details: { widget: { version: 1, title: widget.title, mode: widget.mode, bytes: widget.bytes } },
      };
    },
  });
}

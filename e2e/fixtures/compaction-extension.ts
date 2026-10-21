import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Load only in a disposable PI configuration: compacts on demand with PI's
 * own summarizer and resolves once the compaction is written, so HUI's settle
 * refresh already shows it. */
export default function compactionFixture(pi: ExtensionAPI) {
  pi.registerCommand("fixture-compact", {
    description: "Compact the session with PI's summarizer",
    handler: (args, ctx) => new Promise<void>((resolve, reject) => {
      ctx.compact({ customInstructions: args || undefined, onComplete: () => resolve(), onError: reject });
    }),
  });
}

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Copied into the isolated PI extension directory by the HUI-04 runbook. */
export default function questionFixture(pi: ExtensionAPI) {
  pi.registerCommand("hui-e2e-question", {
    description: "Open a deterministic RPC input request",
    handler: async (args, ctx) => {
      const value = args === "select"
        ? await ctx.ui.select("HUI E2E choice", ["First option", "Second option"])
        : args === "confirm"
          ? await ctx.ui.confirm("HUI E2E confirmation", "Confirm the isolated fixture action.")
          : args === "editor"
            ? await ctx.ui.editor("HUI E2E editor", "Initial fixture text")
            : await ctx.ui.input("HUI E2E question", "Type browser answer");
      ctx.ui.notify(value === undefined ? "Question cancelled" : `Question answered: ${value}`, "info");
    },
  });
}

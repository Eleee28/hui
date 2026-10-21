import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** Load only in a disposable PI configuration for command and extension-tool journeys. */
export default function slashCommandsFixture(pi: ExtensionAPI) {
  pi.registerTool({
    name: "fixture_echo", label: "Fixture echo", description: "Echo text from the isolated PI extension.",
    parameters: Type.Object({ text: Type.String() }),
    async execute(_id, { text }) {
      return { content: [{ type: "text", text: `Extension tool executed: ${text}` }], details: {} };
    },
  });
  pi.registerCommand("check-status", {
    description: "Report extension status without a model turn",
    handler: async (args, ctx) => {
      ctx.ui.notify(`Extension executed: ${args}`, "info");
    },
  });
}

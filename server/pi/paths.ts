/**
 * Locates PI's agent directory from the environment: PI's canonical override first, then the aliases HUI
 * accepted before, then ~/.pi/agent.
 */
import { homedir } from "node:os";
import { join } from "node:path";

/** Match PI's canonical override and HUI's legacy directory aliases. */
export function resolvePiAgentDir(
  env: Readonly<Record<string, string | undefined>> = process.env,
  home = homedir(),
): string {
  return (
    env["PI_CODING_AGENT_DIR"] ??
    env["PI_AGENT_DIR"] ??
    join(env["PI_CONFIG_DIR"] ?? join(home, ".pi"), "agent")
  );
}

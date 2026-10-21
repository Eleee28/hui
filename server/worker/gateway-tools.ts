/**
 * HUI tools that act on the gateway's machine: the shared terminal's PTYs, the managed browser and watchers' processes
 * all live where the gateway runs. A session on a remote worker reaches HUI's tools through the gateway's bridge
 * (`workers.ts`), which refuses these; a bot's chat on a worker isn't offered them at all (the worker host's
 * `DurableHost` gets this list as `gatewayOnlyTools`), so its model never calls them, `request_access` can't ask for
 * them and its Tools & skills page doesn't list them. One list for both, so they can't drift. `secret_request` is not one of
 * them: its card is answered on the gateway, but its file is written where the session's commands run, so a worker
 * host asks with its own `secret-request` and a bot's chat there keeps the tool.
 */
export const GATEWAY_ONLY_TOOLS: readonly string[] = Object.freeze(["terminal", "browser", "watcher"]);

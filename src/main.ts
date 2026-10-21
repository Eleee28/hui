/**
 * Browser entry point. It loads the global stylesheets and the pinned Web Awesome components, starts UI error
 * reporting and applies the saved theme before anything paints, and only then loads the app shell.
 */
import "@awesome.me/webawesome/dist/styles/themes/default.css";
import "./styles/tokens.css";
import "./styles/app.css";
import "./styles/openclaw-reference/components.css";
import "./styles/openclaw-shell.css";
import "./styles/openclaw-workspaces.css";
import "./styles/openclaw-chat.css";
import "./styles/openclaw-launch.css";
import "./styles/web-awesome.css";
import "./styles/terminal.css";
import "./styles/browser-pane.css";
import "./styles/work-pane.css";
import "./styles/media-viewer.css";

// Pin the original component runtime; avoid the all-components loader and CDN.
import "@awesome.me/webawesome/dist/components/tab-group/tab-group.js";
import "@awesome.me/webawesome/dist/components/tab/tab.js";
import "@awesome.me/webawesome/dist/components/tab-panel/tab-panel.js";
import "@awesome.me/webawesome/dist/components/switch/switch.js";
import "@awesome.me/webawesome/dist/components/select/select.js";
import "@awesome.me/webawesome/dist/components/option/option.js";
import "@awesome.me/webawesome/dist/components/dropdown/dropdown.js";
import "@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js";
import "@awesome.me/webawesome/dist/components/popover/popover.js";
import "@awesome.me/webawesome/dist/components/progress-bar/progress-bar.js";
import "katex/dist/katex.min.css";
import "./components/select-picker.ts";
import "./components/rich-embeds.ts";
import "./components/media-viewer.ts";

import { installUiErrorReporting } from "./api/ui-errors.ts";
import { applyThemeMode } from "./lib/theme/theme.ts";
import { loadSettings } from "./lib/settings/settings-store.ts";
import { applyTheme, loadThemes } from "./lib/theme/theme-store.ts";
import { finishBoot, rememberBootLook, showBootFailure } from "./lib/boot-screen.ts";
import { viewAssetsLoaded } from "./lib/view-assets.ts";

// First, so failures while the app starts are reported too.
installUiErrorReporting();

// Resolve the theme, the type stack and the color mode before the app renders,
// so a saved appearance never paints its fallback first. Every step degrades to
// the tokens.css defaults when the config backend is unreachable.
async function resolveAppearance(): Promise<void> {
  const [, settings] = await Promise.all([loadThemes(), loadSettings()]);
  applyThemeMode(settings.themeMode, (await applyTheme(settings.theme)) ?? "both");
  rememberBootLook();
}

// A theme changed in Settings is remembered once the page is left.
addEventListener("pagehide", () => rememberBootLook());
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") rememberBootLook(); });

// The app's code downloads meanwhile: over a slow link it is the longest wait,
// and nothing about it depends on the appearance. index.html's boot screen
// covers both until the app has painted.
try {
  const [{ defineHuiApp }] = await Promise.all([import("./hui-app.ts"), resolveAppearance()]);
  // Every view module has registered its stylesheets by now; they load together.
  await viewAssetsLoaded();
  defineHuiApp();
  await finishBoot(document.querySelector("hui-app"));
} catch (error) {
  showBootFailure(error);
  throw error;
}

/** Browser-local VS Code license links, provider labels and download sizes. */
import type { VscodeProviderKind } from "../api/schema/vscode.ts";

export const VSCODE_SERVER_LICENSE_URL = "https://aka.ms/vscode-server-license";
export const MICROSOFT_PRIVACY_URL = "https://privacy.microsoft.com/en-US/privacystatement";
export const VSCODE_DOWNLOAD_URL = "https://code.visualstudio.com/download";
/** openvscode-server is MIT; HUI downloads Gitpod's release, it does not ship it. */
export const OPENVSCODE_SERVER_URL = "https://github.com/gitpod-io/openvscode-server";
export const OPENVSCODE_SERVER_LICENSE_URL = "https://github.com/gitpod-io/openvscode-server/blob/main/LICENSE.txt";

/** Where a provider comes from, as Settings words it. */
export function vscodeProviderSource(kind: VscodeProviderKind): string {
  switch (kind) {
    case "configured": return "the path in Settings";
    case "desktop": return "your VS Code";
    case "managed": return "installed by HUI";
    default: return "found on PATH";
  }
}

/** "77 MB" for a download size. */
export function formatVscodeBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

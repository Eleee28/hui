/** Presentation labels never retain URL credentials, signed queries or local
 * absolute paths. Exact sources remain server-side mutation identifiers. */
export function safeSourceLabel(source: string): string {
  const trimmed = source.trim();
  const npm = trimmed.startsWith("npm:") ? trimmed.slice(4) : "";
  if (npm) return npm.split("?")[0] ?? npm;
  const urlSource = trimmed.replace(/^git\+/u, "");
  try {
    const url = new URL(urlSource);
    const leaf = url.pathname.split("/").filter(Boolean).at(-1)?.replace(/\.git$/u, "") ?? "package";
    return url.hostname ? `${url.hostname}/${leaf}` : leaf;
  } catch {
    return trimmed.split(/[\\/]/u).filter(Boolean).at(-1) ?? "package";
  }
}

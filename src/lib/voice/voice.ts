/**
 * Small rules a bot's calls share in the browser (HUI-18): how a call's time
 * reads, the Language picker's options and what a microphone error means.
 */
import { VOICE_LANGUAGES, voiceLanguageName, whisperLanguageName, type LanguageNames } from "./languages.ts";
import type { VoiceLanguage } from "../../api/schema/bots.ts";

/** `65` seconds → `1:05`; an hour or more → `1:02:05`. */
export function formatCallTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

/**
 * The Language picker: Auto (the bot answers in the language it hears) first, then Whisper's languages by their
 * English name, each with its code, and Whisper's own name where the browser calls it something else (Bangla for
 * Bengali), so a search finds a language by either name or by its code.
 */
export function languageOptions(names?: LanguageNames | null): { value: string; label: string; description?: string }[] {
  const languages = (Object.entries(VOICE_LANGUAGES) as [VoiceLanguage, string][]).map(([code, whisper]) => {
    const label = voiceLanguageName(code, names);
    const alias = label.toLocaleLowerCase("en") === whisper ? "" : ` · ${whisperLanguageName(code)}`;
    return { value: code, label, description: `${code}${alias}` };
  });
  return [{ value: "", label: "Auto (detect)" }, ...languages.sort((a, b) => a.label.localeCompare(b.label, "en"))];
}

/** Whether this page can have the microphone at all: browsers give it only to secure pages, HUI's desktop app to none. */
export function microphoneContext(): { secure: boolean; desktop: boolean } {
  return {
    secure: typeof window === "undefined" || (window.isSecureContext && Boolean(navigator.mediaDevices?.getUserMedia)),
    desktop: typeof navigator !== "undefined" && /\bElectron\//u.test(navigator.userAgent),
  };
}

/**
 * Why the microphone could not be used, in words: denied, missing, busy, or a
 * page the browser will not give a microphone to (plain HTTP away from this
 * machine, or HUI's desktop app, which allows none yet).
 */
export function microphoneErrorMessage(error: unknown, context: { secure: boolean; desktop: boolean }): string {
  if (context.desktop) return "HUI's desktop app does not allow the microphone yet. Open HUI in a browser to talk to bots.";
  if (!context.secure) return "Browsers give the microphone only to secure pages: open HUI on https:// (Tailscale Serve, say) or on this machine's localhost.";
  const name = error instanceof Error || error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") return "Microphone access was denied. Allow it for this site in the browser's settings, then try again.";
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") return "No microphone was found. Connect one and try again.";
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") return "The microphone is busy or unavailable. Close other apps using it and try again.";
  return error instanceof Error && error.message ? `The microphone could not be opened: ${error.message}` : "The microphone could not be opened.";
}

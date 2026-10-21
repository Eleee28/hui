/**
 * The language a bot speaks on calls (HUI-18), the browser's copy of
 * server/bots/voice-languages.ts: Whisper's codes and names, and their English names.
 */
import type { VoiceLanguage } from "../../api/schema/bots.ts";

/**
 * The languages a bot can speak on calls: Whisper's 100, with its names and in
 * its order (openai/whisper, whisper/tokenizer.py `LANGUAGES`). The codes are
 * ISO 639-1, except Hawaiian `haw` and Cantonese `yue` (ISO 639-3) and
 * Javanese, which Whisper writes `jw` for ISO's `jv`.
 */
export const VOICE_LANGUAGES = {
  en: "english", zh: "chinese", de: "german", es: "spanish", ru: "russian", ko: "korean", fr: "french",
  ja: "japanese", pt: "portuguese", tr: "turkish", pl: "polish", ca: "catalan", nl: "dutch", ar: "arabic",
  sv: "swedish", it: "italian", id: "indonesian", hi: "hindi", fi: "finnish", vi: "vietnamese", he: "hebrew",
  uk: "ukrainian", el: "greek", ms: "malay", cs: "czech", ro: "romanian", da: "danish", hu: "hungarian", ta: "tamil",
  no: "norwegian", th: "thai", ur: "urdu", hr: "croatian", bg: "bulgarian", lt: "lithuanian", la: "latin",
  mi: "maori", ml: "malayalam", cy: "welsh", sk: "slovak", te: "telugu", fa: "persian", lv: "latvian", bn: "bengali",
  sr: "serbian", az: "azerbaijani", sl: "slovenian", kn: "kannada", et: "estonian", mk: "macedonian", br: "breton",
  eu: "basque", is: "icelandic", hy: "armenian", ne: "nepali", mn: "mongolian", bs: "bosnian", kk: "kazakh",
  sq: "albanian", sw: "swahili", gl: "galician", mr: "marathi", pa: "punjabi", si: "sinhala", km: "khmer",
  sn: "shona", yo: "yoruba", so: "somali", af: "afrikaans", oc: "occitan", ka: "georgian", be: "belarusian",
  tg: "tajik", sd: "sindhi", gu: "gujarati", am: "amharic", yi: "yiddish", lo: "lao", uz: "uzbek", fo: "faroese",
  ht: "haitian creole", ps: "pashto", tk: "turkmen", nn: "nynorsk", mt: "maltese", sa: "sanskrit",
  lb: "luxembourgish", my: "myanmar", bo: "tibetan", tl: "tagalog", mg: "malagasy", as: "assamese", tt: "tatar",
  haw: "hawaiian", ln: "lingala", ha: "hausa", ba: "bashkir", jw: "javanese", su: "sundanese", yue: "cantonese",
} as const satisfies Record<VoiceLanguage, string>;

const LANGUAGE_CODES: ReadonlySet<string> = new Set(Object.keys(VOICE_LANGUAGES));

/** One of Whisper's language codes (trimmed, in any case); undefined for anything else, a name included. */
export function voiceLanguage(value: unknown): VoiceLanguage | undefined {
  if (typeof value !== "string") return undefined;
  const code = value.trim().toLowerCase();
  return LANGUAGE_CODES.has(code) ? code as VoiceLanguage : undefined;
}

/** Whisper's name for the language, capitalized: `Haitian Creole`. */
export function whisperLanguageName(code: VoiceLanguage): string {
  return VOICE_LANGUAGES[code].replace(/(^|\s)\p{Ll}/gu, (initial) => initial.toUpperCase());
}

/** What names languages: the platform's `Intl.DisplayNames`, or a stand-in under test. */
export type LanguageNames = { of(code: string): string | undefined };

let englishNames: LanguageNames | null | undefined;

function platformNames(): LanguageNames | null {
  if (englishNames === undefined) {
    try {
      englishNames = new Intl.DisplayNames(["en"], { type: "language", fallback: "none" });
    } catch {
      englishNames = null;
    }
  }
  return englishNames;
}

/** The language's English name (HUI's UI language): the platform's, else Whisper's. */
export function voiceLanguageName(code: VoiceLanguage, names: LanguageNames | null = platformNames()): string {
  let name: string | undefined;
  try {
    name = names?.of(code);
  } catch {
    name = undefined;
  }
  return name || whisperLanguageName(code);
}

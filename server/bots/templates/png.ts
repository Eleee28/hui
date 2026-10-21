/**
 * The text chunks of a PNG image, where character cards travel: `chara` (Character Card V2, base64 JSON) and `ccv3`
 * (V3). tEXt, zTXt and iTXt are read, the image itself never; inflating a compressed chunk is bounded.
 */
import { inflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** The most one text chunk may inflate to. */
const MAX_TEXT_BYTES = 8 * 1024 * 1024;

export function isPng(data: Buffer): boolean {
  return data.length >= SIGNATURE.length && data.subarray(0, SIGNATURE.length).equals(SIGNATURE);
}

/** Keyword → text of each text chunk, the first of a keyword winning; malformed chunks are skipped. */
export function pngTextChunks(data: Buffer): Map<string, string> {
  const chunks = new Map<string, string>();
  if (!isPng(data)) return chunks;
  let at = SIGNATURE.length;
  while (at + 12 <= data.length) {
    const length = data.readUInt32BE(at);
    const type = data.subarray(at + 4, at + 8).toString("latin1");
    const start = at + 8;
    const end = start + length;
    if (end + 4 > data.length) break;
    at = end + 4;
    if (type === "IEND") break;
    if (type !== "tEXt" && type !== "zTXt" && type !== "iTXt") continue;
    const body = data.subarray(start, end);
    const nul = body.indexOf(0);
    if (nul < 1 || nul > 79) continue;
    const keyword = body.subarray(0, nul).toString("latin1");
    if (chunks.has(keyword)) continue;
    try {
      if (type === "tEXt") chunks.set(keyword, body.subarray(nul + 1).toString("latin1"));
      else if (type === "zTXt") chunks.set(keyword, inflateSync(body.subarray(nul + 2), { maxOutputLength: MAX_TEXT_BYTES }).toString("latin1"));
      else {
        const compressed = body[nul + 1] === 1;
        const language = body.indexOf(0, nul + 3);
        const translated = language === -1 ? -1 : body.indexOf(0, language + 1);
        if (translated === -1) continue;
        const text = body.subarray(translated + 1);
        chunks.set(keyword, (compressed ? inflateSync(text, { maxOutputLength: MAX_TEXT_BYTES }) : text).toString("utf8"));
      }
    } catch {
      // A chunk that does not inflate is left out; another may still hold the card.
    }
  }
  return chunks;
}

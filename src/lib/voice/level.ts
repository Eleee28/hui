/**
 * Audio levels on a call (HUI-18): the microphone's and the bot's voice's,
 * from what an analyser on each stream hears. They tell when someone speaks
 * and move the bot's face. 0 is silence, 1 is loud speech. Pure, so tests feed
 * it synthetic audio.
 */

/** At and below this (dBFS) a level is 0: a quiet room. */
export const LEVEL_FLOOR_DB = -60;
/** At and above this (dBFS) a level is 1: loud speech close to the microphone, or a voice at full scale. */
export const LEVEL_CEILING_DB = -14;

/** A frame's loudness in dBFS: its RMS, with digital silence at -120. */
export function frameLevelDb(frame: Float32Array): number {
  let sum = 0;
  for (const sample of frame) sum += sample * sample;
  const rms = Math.sqrt(sum / Math.max(1, frame.length));
  return rms > 0 ? Math.max(-120, 20 * Math.log10(rms)) : -120;
}

export function levelFromDb(db: number): number {
  if (!Number.isFinite(db)) return 0;
  return Math.max(0, Math.min(1, (db - LEVEL_FLOOR_DB) / (LEVEL_CEILING_DB - LEVEL_FLOOR_DB)));
}

/** The level of one frame of samples. */
export function frameLevel(frame: Float32Array): number {
  return levelFromDb(frameLevelDb(frame));
}

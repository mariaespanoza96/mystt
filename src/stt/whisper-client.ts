import { MODEL_SAMPLE_RATE } from "../audio/resampler.js";

/**
 * One-shot client for an OpenAI-compatible transcription endpoint
 * (`POST /v1/audio/transcriptions`, multipart). Built for a local whisper.cpp
 * `whisper-server --inference-path /v1/audio/transcriptions`, and works
 * unchanged against speaches, faster-whisper-server or OpenAI itself.
 */

export interface WhisperRequest {
  url: string;
  apiKey: string | undefined;
  model: string | undefined;
  language: string | undefined;
  /** Earlier text of the same utterance, so a continuation chunk keeps its context. */
  prompt?: string;
  timeoutMs: number;
}

/** whisper.cpp refuses input shorter than 1 s, so short clips are padded with silence. */
const MIN_AUDIO_BYTES = Math.ceil(MODEL_SAMPLE_RATE * 1.1) * 2;
const PROMPT_CHARS = 200;

export async function transcribePcm(pcm16Mono: Buffer, request: WhisperRequest): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(wav(pcm16Mono))], { type: "audio/wav" }), "audio.wav");
  form.append("response_format", "json");
  form.append("temperature", "0");
  // whisper.cpp: keep non-speech tokens (music notes, sound effects) out of the output.
  form.append("suppress_nst", "true");
  if (request.model) form.append("model", request.model);
  if (request.language) form.append("language", request.language);
  if (request.prompt) form.append("prompt", request.prompt.slice(-PROMPT_CHARS));

  const response = await fetch(request.url, {
    method: "POST",
    body: form,
    headers: request.apiKey ? { Authorization: `Bearer ${request.apiKey}` } : {},
    signal: AbortSignal.timeout(request.timeoutMs),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 200);
    throw new Error(`transcription request failed: HTTP ${response.status} ${detail}`.trim());
  }
  const body = (await response.json()) as { text?: unknown; error?: unknown };
  if (typeof body.text !== "string") throw new Error(`transcription response has no text: ${JSON.stringify(body).slice(0, 200)}`);
  return cleanTranscript(body.text);
}

/**
 * Whisper marks non-speech as `[BLANK_AUDIO]`, `[Music]`, `(laughs)` and so on.
 * Those tags are not words anybody said, so they never reach the channel.
 */
export function cleanTranscript(text: string): string {
  return text
    .replace(/\[[^\]]*\]|\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Phrases Whisper produces from silence and noise, learned from video
 * subtitles. Matched only against a chunk's entire transcript, so "thank you
 * for the help" is kept; a lone spoken "thank you" is the accepted casualty.
 */
const STOCK_PHRASES = new Set([
  "you",
  "thank you",
  "thanks",
  "thank you very much",
  "thank you so much",
  "thanks for watching",
  "thank you for watching",
  "thanks for watching and see you next time",
  "please subscribe",
  "like and subscribe",
  "subtitles by the amaraorg community",
  "",
]);

export function isStockPhrase(text: string): boolean {
  const normalised = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  return STOCK_PHRASES.has(normalised);
}

/** Wraps 16 kHz mono s16le in a WAV container, padding to whisper.cpp's minimum length. */
export function wav(pcm16Mono: Buffer): Buffer {
  const data = pcm16Mono.length >= MIN_AUDIO_BYTES ? pcm16Mono : Buffer.concat([pcm16Mono, Buffer.alloc(MIN_AUDIO_BYTES - pcm16Mono.length)]);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(MODEL_SAMPLE_RATE, 24);
  header.writeUInt32LE(MODEL_SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

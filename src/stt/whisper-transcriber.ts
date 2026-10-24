import { MODEL_FRAME_BYTES, MODEL_SAMPLE_RATE, rms } from "../audio/resampler.js";
import { isStockPhrase, transcribePcm } from "./whisper-client.js";
import type { Transcriber, TranscriberOptions, UtteranceHandle } from "./transcriber.js";

/**
 * Turns one speaker's gated audio into text with a request/response model.
 *
 * Audio between `begin()` and `flush()` is one utterance. Long utterances are
 * sent in chunks of about `chunkSeconds`, cut at the quietest recent 100 ms
 * frame so words are rarely split, which lets the line fill while the person is
 * still talking. Requests for one speaker run strictly in order, so text always
 * lands in the line, and in the order, it was spoken.
 *
 * Whisper invents words for silence ("Thank you.", "you"), so trailing quiet is
 * trimmed off every chunk, chunks with no audible speech are never sent, and a
 * chunk whose whole transcript is one of Whisper's stock phrases is dropped.
 */

export type TranscribeFn = (pcm16Mono: Buffer, prompt: string) => Promise<string>;

export interface WhisperTranscriberOptions extends TranscriberOptions {
  /** Consecutive failed chunks before the speaker is reported as degraded. */
  maxFailures?: number;
}

interface Utterance extends UtteranceHandle {
  deliver: (text: string) => void;
  /** Text recognised so far, passed as the prompt for the next chunk. */
  context: string;
  pending: number;
}

/** How far back from the chunk boundary to look for a quiet place to cut. */
const CUT_SEARCH_FRAMES = 15;
const ATTEMPTS = 2;
/** A chunk needs this many audible 100 ms frames to be worth transcribing. */
const MIN_VOICED_FRAMES = 2;
/** Quiet kept after the last audible frame, so soft word endings survive the trim. */
const TAIL_PAD_FRAMES = 2;

export class WhisperTranscriber implements Transcriber {
  private utterance: Utterance | undefined;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private queue: Promise<void> = Promise.resolve();
  private failures = 0;
  private degraded = false;
  private disposed = false;
  private readonly chunkBytes: number;
  private readonly transcribe: TranscribeFn;

  public constructor(private readonly options: WhisperTranscriberOptions) {
    this.chunkBytes = Math.round(options.stt.chunkSeconds * MODEL_SAMPLE_RATE) * 2;
    this.transcribe =
      options.transcribe ??
      ((pcm, prompt) =>
        transcribePcm(pcm, {
          url: options.stt.url,
          apiKey: options.stt.apiKey,
          model: options.stt.model,
          language: options.stt.language,
          prompt,
          timeoutMs: options.stt.timeoutMs,
        }));
  }

  public begin(deliver: (text: string) => void): UtteranceHandle {
    if (this.utterance) this.flush();
    const utterance: Utterance = { deliver, context: "", pending: 0 };
    if (!this.disposed) this.utterance = utterance;
    return utterance;
  }

  public append(pcm16Mono: Buffer): void {
    if (this.disposed || !this.utterance) return;
    this.pending.push(Buffer.from(pcm16Mono));
    this.pendingBytes += pcm16Mono.length;
    if (this.pendingBytes >= this.chunkBytes) this.submitChunk();
  }

  /** Closes the utterance and sends whatever audio is left of it. */
  public flush(): void {
    const utterance = this.utterance;
    this.utterance = undefined;
    if (!utterance || this.pendingBytes === 0) return;
    this.submit(utterance, this.takePending());
  }

  public async close(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.utterance = undefined;
    this.takePending();
    await this.queue;
  }

  private submitChunk(): void {
    const utterance = this.utterance;
    if (!utterance) return;
    const audio = this.takePending();
    const cut = quietestCut(audio);
    if (cut < audio.length) {
      const rest = Buffer.from(audio.subarray(cut));
      this.pending.push(rest);
      this.pendingBytes = rest.length;
    }
    this.submit(utterance, audio.subarray(0, cut));
  }

  private submit(utterance: Utterance, chunk: Buffer): void {
    const audio = trimSilence(chunk, this.options.rmsThreshold);
    if (!audio) return;
    utterance.pending += 1;
    this.queue = this.queue
      .then(() => this.run(utterance, audio))
      .finally(() => {
        utterance.pending -= 1;
      });
  }

  private async run(utterance: Utterance, audio: Buffer): Promise<void> {
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      if (this.disposed) return;
      try {
        const text = await this.transcribe(audio, utterance.context);
        this.failures = 0;
        if (!text || this.disposed) return;
        if (isStockPhrase(text)) {
          this.options.logger.debug({ userId: this.options.userId, text }, "dropped a likely whisper hallucination");
          return;
        }
        utterance.deliver(utterance.context ? ` ${text}` : text);
        utterance.context = utterance.context ? `${utterance.context} ${text}` : text;
        return;
      } catch (error) {
        this.options.logger.warn(
          { err: error, userId: this.options.userId, attempt, audioMs: (audio.length / 2 / MODEL_SAMPLE_RATE) * 1000 },
          "speaker transcription failed",
        );
        if (attempt === ATTEMPTS) this.recordFailure(error instanceof Error ? error.message : String(error));
      }
    }
  }

  private recordFailure(reason: string): void {
    this.failures += 1;
    if (this.degraded || this.failures < (this.options.maxFailures ?? 3)) return;
    this.degraded = true;
    this.options.onDegraded(reason);
  }

  private takePending(): Buffer {
    const audio = Buffer.concat(this.pending);
    this.pending = [];
    this.pendingBytes = 0;
    return audio;
  }
}

/**
 * Cuts the quiet tail off a chunk (the gate's hangover ends every utterance
 * with ~700 ms of it). Undefined when the chunk has no audible speech at all.
 */
export function trimSilence(audio: Buffer, rmsThreshold: number): Buffer | undefined {
  const frames = Math.ceil(audio.length / MODEL_FRAME_BYTES);
  let voiced = 0;
  let lastVoiced = -1;
  for (let index = 0; index < frames; index += 1) {
    if (rms(audio.subarray(index * MODEL_FRAME_BYTES, (index + 1) * MODEL_FRAME_BYTES)) < rmsThreshold) continue;
    voiced += 1;
    lastVoiced = index;
  }
  if (voiced < MIN_VOICED_FRAMES) return undefined;
  return audio.subarray(0, Math.min(audio.length, (lastVoiced + 1 + TAIL_PAD_FRAMES) * MODEL_FRAME_BYTES));
}

/** Byte offset just after the quietest 100 ms frame near the end of `audio`. */
export function quietestCut(audio: Buffer): number {
  const frames = Math.floor(audio.length / MODEL_FRAME_BYTES);
  if (frames < 2) return audio.length;
  let best = frames - 1;
  let bestLevel = Number.POSITIVE_INFINITY;
  for (let index = frames - 1; index >= Math.max(1, frames - CUT_SEARCH_FRAMES); index -= 1) {
    const level = rms(audio.subarray(index * MODEL_FRAME_BYTES, (index + 1) * MODEL_FRAME_BYTES));
    if (level < bestLevel) {
      bestLevel = level;
      best = index;
    }
  }
  return (best + 1) * MODEL_FRAME_BYTES;
}

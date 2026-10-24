import type { Logger } from "../logger.js";
import type { SttConfig } from "../config.js";
import { RealtimeTranscriber } from "./realtime-transcriber.js";
import { WhisperTranscriber, type TranscribeFn } from "./whisper-transcriber.js";

/**
 * What a speaker pipeline needs from speech-to-text, whichever backend serves
 * it: a request/response Whisper endpoint or the Mistral realtime socket.
 */

/** Lets the caller see whether an utterance still has text on the way. */
export interface UtteranceHandle {
  /** Requests of this utterance queued or running; always 0 for a streaming backend. */
  readonly pending: number;
}

export interface Transcriber {
  /**
   * Opens an utterance; every piece of text recognised for it goes to
   * `deliver`, already spaced so the pieces can be concatenated as they come.
   */
  begin(deliver: (text: string) => void): UtteranceHandle;
  /** Feeds one 16 kHz mono frame of the open utterance. */
  append(pcm16Mono: Buffer): void;
  /** The utterance ended; decode what is left of it now. */
  flush(): void;
  close(): Promise<void>;
}

export interface TranscriberOptions {
  userId: string;
  stt: SttConfig;
  /** The loudness gate's threshold; frames below it count as quiet. */
  rmsThreshold: number;
  logger: Logger;
  /** Called once when the speaker's audio can no longer be transcribed. */
  onDegraded: (reason: string) => void;
  /** Whisper only, injectable for tests; defaults to the HTTP client. */
  transcribe?: TranscribeFn;
}

export function createTranscriber(options: TranscriberOptions): Transcriber {
  return options.stt.backend === "realtime" ? new RealtimeTranscriber(options) : new WhisperTranscriber(options);
}

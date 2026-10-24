import { rms } from "./resampler.js";

/**
 * Energy voice-activity gate. Discord only forwards Opus frames for members
 * that are actually transmitting, but a muted-but-noisy microphone still opens
 * a receiver stream, so every utterance is gated on loudness.
 *
 * The gate is deliberately small and synchronous: the pipeline calls `push`
 * once per decoded frame and only forwards what it returns.
 */

export interface SpeechGateOptions {
  rmsThreshold: number;
  speechFramesToStart: number;
  hangoverMs: number;
  preRollMs: number;
  minUtteranceMs: number;
  maxUtteranceMs: number;
}

export interface GateEmission {
  /** Frames the caller should forward to speech-to-text, in order. */
  emit: Buffer[];
  /** True on the frame that opens an utterance. */
  started: boolean;
  /** True on the frame that closes an utterance; `emit` already contains the tail. */
  ended: boolean;
  /** Set when the utterance is shorter than `minUtteranceMs` and should be discarded. */
  tooShort: boolean;
  /** Utterance length in ms once `ended` is true. */
  durationMs: number;
}

const SILENT: GateEmission = { emit: [], started: false, ended: false, tooShort: false, durationMs: 0 };

export class SpeechGate {
  private active = false;
  private streak = 0;
  private quietMs = 0;
  private speechMs = 0;
  private preRoll: { frame: Buffer; ms: number }[] = [];
  private preRollMs = 0;

  public constructor(private readonly options: SpeechGateOptions) {
    if (options.speechFramesToStart < 1) throw new Error("speechFramesToStart must be >= 1");
    if (options.hangoverMs <= 0) throw new Error("hangoverMs must be positive");
  }

  public get speaking(): boolean {
    return this.active;
  }

  /** Feeds one decoded mono frame of `frameMs` duration. */
  public push(frame: Buffer, frameMs: number): GateEmission {
    const loud = rms(frame) >= this.options.rmsThreshold;

    if (!this.active) {
      this.pushPreRoll(frame, frameMs);
      if (!loud) {
        this.streak = 0;
        return SILENT;
      }
      this.streak += 1;
      if (this.streak < this.options.speechFramesToStart) return SILENT;

      this.active = true;
      this.streak = 0;
      this.quietMs = 0;
      this.speechMs = this.preRollMs;
      const emit = this.preRoll.map((entry) => entry.frame);
      this.preRoll = [];
      this.preRollMs = 0;
      return { emit, started: true, ended: false, tooShort: false, durationMs: 0 };
    }

    this.speechMs += frameMs;
    if (loud) this.quietMs = 0;
    else this.quietMs += frameMs;

    const forced = this.speechMs >= this.options.maxUtteranceMs;
    const hung = this.quietMs >= this.options.hangoverMs;
    if (!forced && !hung) return { emit: [frame], started: false, ended: false, tooShort: false, durationMs: 0 };

    const durationMs = this.speechMs;
    this.active = false;
    this.quietMs = 0;
    this.streak = 0;
    const speechMs = this.speechMs;
    this.speechMs = 0;
    return {
      emit: [frame],
      started: false,
      ended: true,
      tooShort: speechMs < this.options.minUtteranceMs,
      durationMs,
    };
  }

  /** Closes an open utterance because the underlying stream ended. */
  public end(): GateEmission {
    if (!this.active) return SILENT;
    const durationMs = this.speechMs;
    this.active = false;
    this.quietMs = 0;
    this.streak = 0;
    this.speechMs = 0;
    return {
      emit: [],
      started: false,
      ended: true,
      tooShort: durationMs < this.options.minUtteranceMs,
      durationMs,
    };
  }

  public reset(): void {
    this.active = false;
    this.streak = 0;
    this.quietMs = 0;
    this.speechMs = 0;
    this.preRoll = [];
    this.preRollMs = 0;
  }

  private pushPreRoll(frame: Buffer, frameMs: number): void {
    if (this.options.preRollMs <= 0) return;
    const copy = Buffer.from(frame);
    this.preRoll.push({ frame: copy, ms: frameMs });
    this.preRollMs += frameMs;
    while (this.preRollMs > this.options.preRollMs && this.preRoll.length > 1) {
      const dropped = this.preRoll.shift();
      if (dropped) this.preRollMs -= dropped.ms;
    }
  }
}
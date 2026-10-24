import WebSocket, { type RawData } from "ws";
import type { Logger } from "../logger.js";
import { MODEL_FRAME_BYTES, MODEL_SAMPLE_RATE, PcmFrameChunker } from "../audio/resampler.js";

/**
 * Thin client for the Mistral realtime transcription socket.
 *
 * Wire protocol (https://docs.mistral.ai/studio/audio/speech-to-text/transcribe-in-realtime):
 *   server -> session.created   | client -> session.update (settings, before audio)
 *   server -> session.updated   | client -> input_audio.append { audio: base64(pcm) }
 *   server -> transcription.text.delta { text } | client -> input_audio.flush / input_audio.end
 *   server -> transcription.done { text }
 *
 * Deltas are append-only: every delta is final for its own slice of audio, so
 * the transcript can be rendered as it arrives.
 */

export type TranscriptionState = "idle" | "connecting" | "ready" | "ending" | "closed";

export interface RealtimeTranscriptionOptions {
  url: string;
  apiKey: string;
  model: string;
  language: string | undefined;
  streamingDelayMs: number;
  contextBias?: readonly string[];
  logger: Logger;
  onDelta: (text: string) => void;
  onDone: (text: string) => void;
  onError: (error: Error) => void;
  onClose: (reason: string) => void;
  connectTimeoutMs?: number;
  endTimeoutMs?: number;
  socketFactory?: (url: string, headers: Record<string, string>) => WebSocket;
}

interface ServerEvent {
  type?: string;
  text?: string;
  session?: Record<string, unknown>;
  error?: { message?: string; code?: number };
}

const MAX_BUFFERED_FRAMES = 300; // 30 s of audio while the socket is still connecting.

export class RealtimeTranscription {
  public state: TranscriptionState = "idle";
  public audioMs = 0;

  private socket: WebSocket | undefined;
  private readonly chunker = new PcmFrameChunker(MODEL_FRAME_BYTES);
  private buffered: Buffer[] = [];
  private bufferedMs = 0;
  private connectTimer: NodeJS.Timeout | undefined;
  private endTimer: NodeJS.Timeout | undefined;
  private endResolve: (() => void) | undefined;
  private closed = false;
  private failed = false;

  public constructor(private readonly options: RealtimeTranscriptionOptions) {}

  public get isReady(): boolean {
    return this.state === "ready";
  }

  public get isOpen(): boolean {
    return this.state === "connecting" || this.state === "ready";
  }

  public async connect(): Promise<void> {
    if (this.state !== "idle") throw new Error(`cannot connect from state ${this.state}`);
    this.state = "connecting";

    const url = `${this.options.url}?model=${encodeURIComponent(this.options.model)}`;
    const factory = this.options.socketFactory ?? ((target, headers) => new WebSocket(target, { headers }));
    let socket: WebSocket;
    try {
      socket = factory(url, { Authorization: `Bearer ${this.options.apiKey}` });
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      const timeoutMs = this.options.connectTimeoutMs ?? 8_000;
      this.connectTimer = setTimeout(() => {
        const error = new Error(`realtime transcription connect timed out after ${timeoutMs} ms`);
        this.fail(error);
        reject(error);
      }, timeoutMs);
      this.connectTimer.unref?.();

      let settled = false;
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve();
      };

      socket.on("open", () => {
        this.options.logger.debug({}, "realtime transcription socket open");
      });
      socket.on("message", (raw) => {
        const event = this.parse(raw);
        if (!event) return;
        if (event.type === "session.created") {
          this.send({
            type: "session.update",
            session: {
              audio_format: { encoding: "pcm_s16le", sample_rate: MODEL_SAMPLE_RATE },
              target_streaming_delay_ms: this.options.streamingDelayMs,
              ...(this.options.language ? { language: this.options.language } : {}),
              ...(this.options.contextBias && this.options.contextBias.length > 0
                ? { context_bias: this.options.contextBias.slice(0, 120) }
                : {}),
            },
          });
          return;
        }
        if (event.type === "session.updated") {
          this.state = "ready";
          clearTimeout(this.connectTimer);
          this.connectTimer = undefined;
          this.flushBuffered();
          settle();
          return;
        }
        if (event.type === "transcription.text.delta") {
          const text = event.text ?? "";
          if (text) this.options.onDelta(text);
          return;
        }
        if (event.type === "transcription.done") {
          this.options.onDone(event.text ?? "");
          this.finishEnd();
          return;
        }
        if (event.type === "error") {
          this.options.logger.warn({ code: event.error?.code }, "realtime transcription event error");
          this.fail(new Error(event.error?.message ?? "realtime transcription error"));
          settle(new Error(event.error?.message ?? "realtime transcription error"));
        }
      });
      socket.on("close", (code) => {
        const reason = `realtime transcription socket closed (${code})`;
        if (this.state !== "ending" && !this.failed && !this.closed) this.options.onError(new Error(reason));
        this.fail(new Error(reason), false);
        settle(new Error(reason));
      });
      socket.on("error", (error) => {
        this.options.logger.warn({ err: error }, "realtime transcription socket error");
        if (!settled) {
          this.fail(error);
          settle(error);
        }
      });
    });
  }

  /** Queues 16 kHz mono audio; frames are regrouped into 100 ms appends. */
  public append(pcm16Mono: Buffer): void {
    if (this.closed) return;
    this.audioMs += (pcm16Mono.length / 2 / MODEL_SAMPLE_RATE) * 1000;
    for (const frame of this.chunker.push(pcm16Mono)) this.sendAudio(frame);
  }

  /** Asks the model to decode what it already has without ending the session. */
  public flush(): void {
    if (this.state === "ready") this.send({ type: "input_audio.flush" });
  }

  /** Ends the session and resolves once the final transcript (or a timeout) arrives. */
  public async end(): Promise<void> {
    if (this.state === "closed" || this.state === "ending") return;
    if (!this.isOpen) {
      this.close("ended before ready");
      return;
    }
    this.state = "ending";
    const tail = this.chunker.flush();
    if (tail) this.sendAudio(tail);

    await new Promise<void>((resolve) => {
      this.endResolve = resolve;
      this.endTimer = setTimeout(() => this.finishEnd(true), this.options.endTimeoutMs ?? 3_000);
      this.endTimer.unref?.();
      this.send({ type: "input_audio.end" });
    });
    this.close("ended");
  }

  public close(reason = "closed by caller"): void {
    if (this.closed) return;
    this.closed = true;
    this.state = "closed";
    clearTimeout(this.connectTimer);
    clearTimeout(this.endTimer);
    this.endResolve?.();
    this.endResolve = undefined;
    this.buffered = [];
    try {
      this.socket?.close(1000, reason.slice(0, 100));
    } catch {
      // Socket already gone.
    }
    this.options.onClose(reason);
  }

  private flushBuffered(): void {
    const frames = this.buffered;
    this.buffered = [];
    this.bufferedMs = 0;
    for (const frame of frames) this.sendAudio(frame);
  }

  private sendAudio(frame: Buffer): void {
    if (this.state === "ready" && this.socket?.readyState === WebSocket.OPEN) {
      this.send({ type: "input_audio.append", audio: frame.toString("base64") });
      return;
    }
    if (this.closed) return;
    this.buffered.push(Buffer.from(frame));
    this.bufferedMs += (frame.length / 2 / MODEL_SAMPLE_RATE) * 1000;
    while (this.buffered.length > MAX_BUFFERED_FRAMES) {
      const dropped = this.buffered.shift();
      if (dropped) this.bufferedMs -= (dropped.length / 2 / MODEL_SAMPLE_RATE) * 1000;
    }
  }

  private send(payload: Record<string, unknown>): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(payload));
  }

  private finishEnd(force = false): void {
    clearTimeout(this.endTimer);
    this.endTimer = undefined;
    const resolve = this.endResolve;
    this.endResolve = undefined;
    resolve?.();
    if (force) this.close("end timed out");
  }

  private fail(error: Error, notify = true): void {
    if (this.closed) return;
    this.failed = true;
    clearTimeout(this.connectTimer);
    if (notify) this.options.onError(error);
    this.close(error.message);
  }

  private parse(raw: RawData): ServerEvent | undefined {
    try {
      const parsed = JSON.parse(raw.toString()) as ServerEvent;
      return typeof parsed === "object" && parsed !== null ? parsed : undefined;
    } catch {
      this.options.logger.debug({}, "dropped a non-JSON realtime transcription frame");
      return undefined;
    }
  }
}

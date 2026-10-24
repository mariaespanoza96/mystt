import { RealtimeTranscription } from "./realtime-transcription.js";
import { MODEL_SAMPLE_RATE } from "../audio/resampler.js";
import type { Transcriber, TranscriberOptions, UtteranceHandle } from "./transcriber.js";

/**
 * Keeps one long-lived Mistral realtime socket per connected speaker.
 *
 * A socket survives silence so the next sentence reuses the warm model
 * context, and it is recycled after `maxSessionSeconds` of audio or on failure.
 * Audio that arrives while a socket is (re)connecting is replayed into it, so a
 * reconnect loses no words. Deltas stream into the most recently opened
 * utterance, including ones that land shortly after it ended.
 */

export interface RealtimeTranscriberOptions extends TranscriberOptions {
  connectTimeoutMs?: number;
  maxAttempts?: number;
}

const MAX_REPLAY_BYTES = MODEL_SAMPLE_RATE * 2 * 20; // 20 s
const RETRY_DELAYS_MS = [400, 1_200, 3_000] as const;
/** A stream has no request queue; the pipeline's grace windows cover late deltas. */
const STREAMING: UtteranceHandle = { pending: 0 };

export class RealtimeTranscriber implements Transcriber {
  private deliver: ((text: string) => void) | undefined;
  private session: RealtimeTranscription | undefined;
  private generation = 0;
  private replay: Buffer[] = [];
  private replayBytes = 0;
  private attempts = 0;
  private degraded = false;
  private disposed = false;
  private connectPromise: Promise<void> | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private rotating = false;

  public constructor(private readonly options: RealtimeTranscriberOptions) {}

  public get ready(): boolean {
    return this.session?.isReady === true;
  }

  public begin(deliver: (text: string) => void): UtteranceHandle {
    this.deliver = deliver;
    return STREAMING;
  }

  /** Feeds one 16 kHz mono frame; starts a socket on demand. */
  public append(pcm16Mono: Buffer): void {
    if (this.disposed) return;
    if (this.session?.isReady) {
      this.session.append(pcm16Mono);
      this.rotateIfNeeded();
      return;
    }
    this.bufferReplay(pcm16Mono);
    void this.ensureSession();
  }

  /** Asks the model to decode buffered audio so a finished utterance settles quickly. */
  public flush(): void {
    this.session?.flush();
  }

  public async close(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.deliver = undefined;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    const session = this.session;
    this.session = undefined;
    await session?.end();
  }

  private bufferReplay(pcm: Buffer): void {
    this.replay.push(Buffer.from(pcm));
    this.replayBytes += pcm.length;
    while (this.replayBytes > MAX_REPLAY_BYTES && this.replay.length > 1) {
      const dropped = this.replay.shift();
      if (dropped) this.replayBytes -= dropped.length;
    }
  }

  private takeReplay(): Buffer[] {
    const frames = this.replay;
    this.replay = [];
    this.replayBytes = 0;
    return frames;
  }

  private ensureSession(): Promise<void> {
    if (this.disposed || this.session) return this.connectPromise ?? Promise.resolve();
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;

    const generation = ++this.generation;
    const session = new RealtimeTranscription({
      url: this.options.stt.url,
      apiKey: this.options.stt.apiKey ?? "",
      model: this.options.stt.model ?? "",
      language: this.options.stt.language,
      streamingDelayMs: this.options.stt.streamingDelayMs,
      logger: this.options.logger,
      connectTimeoutMs: this.options.connectTimeoutMs,
      onDelta: (text) => {
        if (generation !== this.generation && !this.rotating) return;
        this.deliver?.(text);
      },
      onDone: () => undefined,
      onError: (error) => this.options.logger.debug({ err: error, userId: this.options.userId }, "speaker socket error"),
      onClose: (reason) => this.handleClose(session, generation, reason),
    });
    this.session = session;

    this.connectPromise = session
      .connect()
      .then(() => {
        if (this.disposed || this.session !== session) return;
        this.attempts = 0;
        this.rotating = false;
        for (const frame of this.takeReplay()) session.append(frame);
      })
      .catch((error: unknown) => {
        if (this.disposed || this.session !== session) return;
        this.session = undefined;
        this.scheduleRetry(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (this.connectPromise) this.connectPromise = undefined;
      });

    return this.connectPromise;
  }

  private handleClose(session: RealtimeTranscription, generation: number, reason: string): void {
    if (this.session === session) this.session = undefined;
    if (this.disposed || generation !== this.generation) return;
    if (reason === "ended") return; // normal rotation
    if (reason.startsWith("realtime transcription socket closed (1000")) return;
    this.scheduleRetry(reason);
  }

  private scheduleRetry(reason: string): void {
    if (this.disposed || this.retryTimer) return;
    const delay = RETRY_DELAYS_MS[Math.min(this.attempts, RETRY_DELAYS_MS.length - 1)] ?? 3_000;
    this.attempts += 1;
    const maxAttempts = this.options.maxAttempts ?? RETRY_DELAYS_MS.length + 1;
    if (this.attempts > maxAttempts) {
      if (!this.degraded) {
        this.degraded = true;
        this.options.onDegraded(reason);
      }
      return;
    }
    this.options.logger.debug(
      { userId: this.options.userId, attempt: this.attempts, delayMs: delay, reason },
      "reconnecting speaker transcription",
    );
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.ensureSession();
    }, delay);
    this.retryTimer.unref?.();
  }

  private rotateIfNeeded(): void {
    const session = this.session;
    if (!session || this.rotating) return;
    if (session.audioMs < this.options.stt.maxSessionSeconds * 1000) return;
    this.rotating = true;
    const frames = Buffer.concat(this.takeReplay());
    void session.end().finally(() => {
      this.rotating = false;
      if (frames.length > 0) this.bufferReplay(frames);
    });
    this.session = undefined;
    void this.ensureSession();
  }
}

import { randomUUID } from "node:crypto";
import type { Logger } from "../logger.js";
import type { SttConfig, VadConfig } from "../config.js";
import { MODEL_FRAME_BYTES, MODEL_SAMPLE_RATE, Stereo48kToMono16k } from "../audio/resampler.js";
import { SpeechGate } from "../audio/speech-gate.js";
import { createTranscriber, type Transcriber, type UtteranceHandle } from "../stt/transcriber.js";
import type { TranscribeFn } from "../stt/whisper-transcriber.js";
import { ChannelWriter, CONTENT_SOFT_LIMIT, type SpeakerStyle, type TranscriptMessage } from "../transcript/writer.js";

/**
 * Everything that happens for one speaking member:
 *
 *   decoder PCM -> downsample -> loudness gate -> STT (whisper or realtime) -> live message
 *
 * An utterance opens when the gate first hears speech and closes after the
 * hangover. Its last chunk is transcribed after that, so the message is
 * finalised on a grace timer that waits for outstanding requests and that
 * every new piece of text pushes back.
 */

/** Text may land after the last audio frame; wait this long before freezing a line. */
export const FINALISE_GRACE_MS = 1_400;
/**
 * A line stays re-openable for this long after the grace, so text from a slow
 * request still lands in the line it belongs to instead of being dropped.
 */
export const LATE_DELTA_WINDOW_MS = 4_000;

export interface SpeakerPipelineOptions {
  userId: string;
  displayName: string;
  avatarUrl?: string;
  /** Embed colour for this speaker's lines (0xRRGGBB). */
  color: number;
  writer: ChannelWriter;
  stt: SttConfig;
  vad: VadConfig;
  logger: Logger;
  onDegraded: (reason: string) => void;
  /** Called once for every transcript line that reaches the channel. */
  onLine?: () => void;
  /** Injectable for tests; defaults to the HTTP client. */
  transcribe?: TranscribeFn;
  graceMs?: number;
  lateWindowMs?: number;
}

interface Turn {
  id: string;
  startedAt: number;
  lastTextAt: number;
  message: TranscriptMessage | undefined;
  opening: Promise<TranscriptMessage | undefined> | undefined;
  timer: NodeJS.Timeout | undefined;
  closed: boolean;
  finalised: boolean;
  /** Past the grace timer but still accepting late text. */
  dormant: boolean;
  tooShort: boolean;
  /** Text not yet pushed into a message (a continuation send is in flight). */
  text: string;
  stt: UtteranceHandle | undefined;
}

export class SpeakerPipeline {
  private readonly resampler = new Stereo48kToMono16k();
  private readonly gate: SpeechGate;
  private readonly transcriber: Transcriber;
  private readonly log: Logger;
  private readonly graceMs: number;
  private readonly lateWindowMs: number;
  private turn: Turn | undefined;
  /** Every line not yet finalised, including ones superseded while their text is in flight. */
  private readonly live = new Set<Turn>();
  private carry = Buffer.alloc(0);
  private disposed = false;

  public constructor(private readonly options: SpeakerPipelineOptions) {
    this.log = options.logger.child({ userId: options.userId, speaker: options.displayName });
    this.graceMs = options.graceMs ?? FINALISE_GRACE_MS;
    this.lateWindowMs = options.lateWindowMs ?? LATE_DELTA_WINDOW_MS;
    this.gate = new SpeechGate(options.vad);
    this.transcriber = createTranscriber({
      userId: options.userId,
      stt: options.stt,
      rmsThreshold: options.vad.rmsThreshold,
      logger: this.log,
      onDegraded: options.onDegraded,
      transcribe: options.transcribe,
    });
  }

  /** Feeds decoded 48 kHz stereo PCM straight from the Opus decoder. */
  public pushDecoded(stereoPcm: Buffer): void {
    if (this.disposed) return;
    const mono = this.resampler.push(stereoPcm);
    if (mono.length === 0) return;
    this.consumeMono(mono);
  }

  /** The receiver stream ended (silence, leave, or hangup). */
  public endStream(): void {
    if (this.disposed) return;
    const tail = this.resampler.flush();
    if (tail.length > 0) this.consumeMono(tail);
    const emission = this.gate.end();
    if (emission.ended) this.endTurn(emission.tooShort);
  }

  public async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.turn = undefined;
    const turns = [...this.live];
    for (const turn of turns) clearTimeout(turn.timer);
    await Promise.all(turns.map((turn) => this.finishTurn(turn, true)));
    await this.transcriber.close();
    this.resampler.reset();
    this.gate.reset();
  }

  private consumeMono(mono: Buffer): void {
    const frames: Buffer[] = [];
    if (this.carry.length > 0) {
      mono = Buffer.concat([this.carry, mono]);
      this.carry = Buffer.alloc(0);
    }
    let offset = 0;
    while (mono.length - offset >= MODEL_FRAME_BYTES) {
      frames.push(mono.subarray(offset, offset + MODEL_FRAME_BYTES));
      offset += MODEL_FRAME_BYTES;
    }
    if (offset < mono.length) this.carry = Buffer.from(mono.subarray(offset));
    if (frames.length === 0) return;

    for (const frame of frames) {
      // The gate works on 100 ms frames, so the frame itself is the duration unit.
      const emission = this.gate.push(frame, (frame.length / 2 / MODEL_SAMPLE_RATE) * 1000);
      if (emission.started) this.startTurn();
      for (const outgoing of emission.emit) this.transcriber.append(outgoing);
      if (emission.ended) this.endTurn(emission.tooShort);
    }
  }

  private startTurn(): void {
    if (this.disposed) return;
    const previous = this.turn;
    if (previous) {
      // New speech supersedes the line, but its last chunk may still be at the
      // model: detach it and let its own finalise timer close it.
      this.turn = undefined;
      if (!previous.timer) this.scheduleFinalise(previous);
    }
    const turn: Turn = {
      id: randomUUID(),
      startedAt: Date.now(),
      lastTextAt: Date.now(),
      message: undefined,
      opening: undefined,
      timer: undefined,
      closed: false,
      finalised: false,
      dormant: false,
      tooShort: false,
      text: "",
      stt: undefined,
    };
    this.turn = turn;
    this.live.add(turn);
    turn.stt = this.transcriber.begin((text) => this.handleText(turn, text));
    // The ellipsis marks the line as live until the first text replaces it.
    turn.opening = this.options.writer.open(this.style(turn));
    void turn.opening.then((message) => {
      turn.message = message;
      if (message) this.appendText(turn, "");
      if (turn.closed) void this.finishTurn(turn, false);
    });
    this.log.debug({ turnId: turn.id }, "utterance opened");
  }

  private endTurn(tooShort: boolean): void {
    const turn = this.turn;
    if (!turn) return;
    turn.tooShort ||= tooShort;
    // Send the tail of the utterance now; the grace timer waits for its text.
    this.transcriber.flush();
    this.scheduleFinalise(turn);
  }

  private handleText(turn: Turn, text: string): void {
    if (turn.closed) {
      // Text after the line was frozen has nowhere to go.
      this.log.debug({ turnId: turn.id }, "dropped transcription text for a closed line");
      return;
    }
    turn.lastTextAt = Date.now();
    this.appendText(turn, text);
    if (turn.dormant) turn.dormant = false;
    this.scheduleFinalise(turn);
  }

  /**
   * Feeds text into the live message without ever exceeding the Discord limit.
   * Text with no message attached (a continuation is being sent) stays queued
   * in `turn.text` and is drained when that send resolves.
   */
  private appendText(turn: Turn, text: string): void {
    turn.text += text;
    while (turn.text.length > 0) {
      const message = turn.message;
      if (!message) return;
      const room = CONTENT_SOFT_LIMIT - message.text.length;
      if (room <= 0) {
        this.continueMessage(turn);
        return;
      }
      const slice = turn.text.slice(0, room);
      message.pushDelta(slice);
      turn.text = turn.text.slice(slice.length);
    }
  }

  private continueMessage(turn: Turn): void {
    const message = turn.message;
    // A continuation send is already in flight; its resolution drains the rest.
    if (!message) return;
    void message.finalise();
    this.openContinuation(turn);
  }

  /** Opens the next message, retrying a failed send so the tail is never dropped. */
  private openContinuation(turn: Turn): void {
    turn.message = undefined;
    const opening = (async (): Promise<TranscriptMessage | undefined> => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const created = await this.options.writer.open(this.style(turn));
        if (created) return created;
        if (attempt < 2) await new Promise<void>((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
      }
      return undefined;
    })();
    turn.opening = opening;
    void opening.then((created) => {
      turn.message = created;
      // Whatever arrived while the send was in flight belongs to this message,
      // even when the turn closed meanwhile.
      if (created) this.appendText(turn, "");
      if (turn.closed) void this.finishTurn(turn, false);
    });
  }

  private scheduleFinalise(turn: Turn, extended = false): void {
    if (turn.timer) clearTimeout(turn.timer);
    turn.timer = setTimeout(() => {
      turn.timer = undefined;
      // Still audible, or its text is still being transcribed: keep the line open.
      if ((this.turn === turn && this.gate.speaking) || (turn.stt?.pending ?? 0) > 0) {
        this.scheduleFinalise(turn);
        return;
      }
      if (!extended) {
        // First grace passed: park the line as dormant instead of freezing it, so
        // late text can still reopen it.
        turn.dormant = true;
        this.scheduleFinalise(turn, true);
        return;
      }
      this.closeTurn(turn);
    }, extended ? this.lateWindowMs : this.graceMs);
    turn.timer.unref?.();
  }

  private closeTurn(turn: Turn): void {
    if (turn.closed) return;
    if (this.turn === turn) this.turn = undefined;
    turn.closed = true;
    void this.finishTurn(turn, false);
  }

  private async finishTurn(turn: Turn, immediate: boolean): Promise<void> {
    if (turn.finalised) return;
    turn.finalised = true;
    this.live.delete(turn);
    clearTimeout(turn.timer);
    const message = turn.message ?? (turn.opening ? await turn.opening : undefined);
    if (!message) return;
    turn.message = message;
    const body = message.text.trim() || turn.text.trim();
    if (turn.tooShort || !body) {
      await message.remove();
      return;
    }
    if (immediate) message.text = body;
    await message.finalise();
    this.options.onLine?.();
    this.log.debug({ turnId: turn.id, chars: body.length }, "utterance finalised");
  }

  private style(turn: Turn): SpeakerStyle {
    return { name: this.options.displayName, avatarUrl: this.options.avatarUrl, color: this.options.color, startedAt: turn.startedAt };
  }
}
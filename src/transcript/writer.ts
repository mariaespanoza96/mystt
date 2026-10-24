import type { APIEmbed, Message } from "discord.js";
import type { Logger } from "../logger.js";
import type { SendableChannel } from "../discord-types.js";

/**
 * Rate-limit aware writer for a transcript channel.
 *
 * Discord allows roughly five edits per five seconds per message, so deltas are
 * coalesced per message and flushed on a timer that always carries the newest
 * text. All sends go through one serialised pump so a busy channel cannot fan
 * out concurrent requests.
 */

export const DISCORD_CONTENT_LIMIT = 2_000;
export const CONTENT_SOFT_LIMIT = 1_850;

/** How a speaker's lines look: an embed with their name, avatar and colour bar. */
export interface SpeakerStyle {
  name: string;
  avatarUrl: string | undefined;
  color: number;
  /** When the utterance started; shown as the embed timestamp. */
  startedAt: number;
}

interface MessageBody {
  content: string;
  embeds: APIEmbed[];
}

function speakerBody(style: SpeakerStyle, text: string): MessageBody {
  return {
    content: "",
    embeds: [
      {
        author: { name: style.name.slice(0, 80), ...(style.avatarUrl ? { icon_url: style.avatarUrl } : {}) },
        description: clamp(text),
        color: style.color,
        timestamp: new Date(style.startedAt).toISOString(),
      },
    ],
  };
}

export interface ChannelWriterOptions {
  channel: SendableChannel;
  logger: Logger;
  /** Minimum spacing between two edits of the same message. */
  intervalMs: number;
  /** Random extra spacing per message, so simultaneous speakers de-synchronise. */
  jitterMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class TranscriptMessage {
  public text = "";
  public finished = false;

  private lastRendered = "";
  private lastEditAt = 0;
  private timer: NodeJS.Timeout | undefined;
  private failures = 0;
  private readonly spacingMs: number;

  public constructor(
    private readonly writer: ChannelWriter,
    public readonly ref: Message,
    private readonly style: SpeakerStyle,
    private readonly log: Logger,
  ) {
    this.spacingMs = writer.spacingFor(ref.id);
  }

  public get id(): string {
    return this.ref.id;
  }

  /** Queues text; the visible edit lands at most one interval from now. */
  public pushDelta(delta: string): void {
    if (this.finished) return;
    this.text += delta;
    this.schedule();
  }

  /** Writes the current text immediately (used at utterance end). */
  public async finalise(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    this.clearTimer();
    const body = this.render();
    if (body === undefined) {
      await this.remove();
      return;
    }
    await this.waitForSlot();
    this.lastEditAt = this.writer.now();
    await this.writer.edit(this, body);
  }

  public async remove(): Promise<void> {
    this.finished = true;
    this.clearTimer();
    await this.writer.delete(this);
  }

  public render(): MessageBody | undefined {
    const text = this.text.trim();
    if (!text) return undefined;
    return speakerBody(this.style, text);
  }

  private clearTimer(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private async waitForSlot(): Promise<void> {
    const wait = this.lastEditAt + this.spacingMs - this.writer.now();
    if (wait > 0) await this.writer.sleep(wait);
  }

  private schedule(): void {
    if (this.timer || this.finished || this.failures >= 3) return;
    const wait = Math.max(0, this.lastEditAt + this.spacingMs - this.writer.now());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.pump();
    }, wait);
    this.timer.unref?.();
  }

  private async pump(): Promise<void> {
    if (this.finished) return;
    const body = this.render();
    const rendered = body?.embeds[0]?.description;
    if (body === undefined || rendered === this.lastRendered) return;
    this.lastRendered = rendered ?? "";
    this.lastEditAt = this.writer.now();
    const ok = await this.writer.edit(this, body);
    this.failures = ok ? 0 : this.failures + 1;
    if (this.failures >= 3) {
      this.log.warn({ messageId: this.id }, "giving up on transcript message edits");
      return;
    }
    const latest = this.render()?.embeds[0]?.description;
    if (!this.finished && latest !== undefined && latest !== this.lastRendered) this.schedule();
  }
}

export class ChannelWriter {
  private queue: Promise<void> = Promise.resolve();
  private lastSendAt = 0;
  public readonly sleep: (ms: number) => Promise<void>;
  public readonly now: () => number;

  public constructor(private readonly options: ChannelWriterOptions) {
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? (() => Date.now());
  }

  public spacingFor(messageId: string): number {
    // Cheap deterministic per-message jitter: stable across its edits.
    const seed = Number.parseInt(messageId.slice(-4), 10) || 0;
    return this.options.intervalMs + (seed % Math.max(1, this.options.jitterMs + 1));
  }

  /**
   * Posts a speaker's transcript message that an utterance can stream into. It
   * shows an ellipsis until the first text arrives.
   */
  public async open(style: SpeakerStyle): Promise<TranscriptMessage | undefined> {
    const sent = await this.enqueue(
      () => this.options.channel.send({ ...speakerBody(style, "…"), allowedMentions: { parse: [] } }),
      400,
    );
    if (!sent) return undefined;
    return new TranscriptMessage(this, sent, style, this.options.logger);
  }

  /** Posts a short system line (join/leave/config notices). */
  public async system(content: string): Promise<void> {
    await this.enqueue(() => this.options.channel.send({ content: clamp(content), allowedMentions: { parse: [] } }), 400);
  }

  public async edit(message: TranscriptMessage, body: MessageBody): Promise<boolean> {
    const ok = await this.enqueue(async () => {
      await message.ref.edit({ ...body, allowedMentions: { parse: [] } });
      return true;
    }, 0);
    if (ok !== true) this.options.logger.warn({ messageId: message.id }, "transcript message edit failed");
    return ok === true;
  }

  public async delete(message: TranscriptMessage): Promise<void> {
    await this.enqueue(async () => {
      await message.ref.delete();
      return true;
    }, 150);
  }

  /** Serialises every Discord call and keeps a minimum gap before it. */
  private enqueue<T>(task: () => Promise<T>, minGapMs: number): Promise<T | undefined> {
    const run = this.queue.then(async () => {
      const wait = this.lastSendAt + minGapMs - this.now();
      if (wait > 0) await this.sleep(wait);
      this.lastSendAt = this.now();
      return task();
    });
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run.catch((error: unknown) => {
      this.options.logger.warn({ err: error }, "transcript channel operation failed");
      return undefined;
    });
  }
}

export function clamp(content: string): string {
  if (content.length <= DISCORD_CONTENT_LIMIT) return content;
  return `${content.slice(0, DISCORD_CONTENT_LIMIT - 1)}…`;
}

/** Splits text on a word boundary near `limit`, so a long utterance continues in a new message. */
export function splitForContinuation(text: string, limit: number): [string, string] {
  if (text.length <= limit) return [text, ""];
  const window = text.slice(0, limit);
  const boundary = Math.max(window.lastIndexOf(" "), window.lastIndexOf("\n"));
  const cut = boundary > limit * 0.5 ? boundary : limit;
  return [text.slice(0, cut), text.slice(cut)];
}
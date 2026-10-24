import {
  EndBehaviorType,
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
  type AudioReceiveStream,
  type VoiceConnection,
} from "@discordjs/voice";
import {
  ChannelType,
  PermissionFlagsBits,
  type Client,
  type GuildMember,
  type VoiceBasedChannel,
  type VoiceState,
} from "discord.js";
import prism from "prism-media";
import type { Logger } from "../logger.js";
import type { AppConfig } from "../config.js";
import type { SendableChannel } from "../discord-types.js";
import { ChannelWriter } from "../transcript/writer.js";
import { SpeakerPipeline } from "./speaker-pipeline.js";

/**
 * One live join: the bot sits in one voice channel, follows who speaks, and
 * streams each utterance into a text channel as a finalising message line.
 *
 * Diarisation is free here: Discord already hands every member their own Opus
 * stream, so a transcript line is always attributable to an exact member
 * instead of a probabilistic cluster.
 */

export interface ChannelSessionOptions {
  channel: VoiceBasedChannel;
  /** Where transcripts are posted; defaults to the voice channel's own text chat. */
  textChannel: SendableChannel;
  client: Client;
  config: AppConfig;
  logger: Logger;
  /** Called exactly once after the session has fully torn down, for registry cleanup. */
  onEnded?: () => void;
}

// 960 samples per frame at 48 kHz stereo.
const DECODER_FRAME_SIZE = 960;
const IDLE_POLL_MS = 10_000;
const RECEIVER_SILENCE_MS = 1_000;
/**
 * Embed colours handed out in order of first speech, so the first ten speakers
 * in a channel never share one. Chosen to stay distinct on dark and light themes.
 */
export const SPEAKER_COLORS = [
  0xe74c3c, // red
  0x3498db, // blue
  0x2ecc71, // green
  0xf1c40f, // yellow
  0x9b59b6, // purple
  0xe67e22, // orange
  0x1abc9c, // teal
  0xe91e63, // pink
  0x8bc34a, // lime
  0x95a5a6, // grey
] as const;
const REQUIRED_VOICE: bigint[] = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak];

export function missingVoicePermissions(channel: VoiceBasedChannel, member: GuildMember): string[] {
  const permissions = channel.permissionsFor(member);
  if (!permissions) return ["unknown channel permissions"];
  return REQUIRED_VOICE.filter((flag) => !permissions.has(flag)).map(permissionName);
}

function permissionName(flag: bigint): string {
  const entry = Object.entries(PermissionFlagsBits).find(([, value]) => value === flag);
  return entry?.[0] ?? "unknown";
}

export class ChannelSession {
  private readonly writer: ChannelWriter;
  private readonly log: Logger;
  private readonly pipelines = new Map<string, SpeakerPipeline>();
  private readonly activeStreams = new Map<string, AudioReceiveStream>();
  private readonly seenSpeakers = new Set<string>();
  /** Colour per member, kept for the whole session even if they leave and return. */
  private readonly speakerColors = new Map<string, number>();
  private readonly speaking = (userId: string) => this.handleSpeakerStart(userId);
  private readonly startedAt = Date.now();
  private connection: VoiceConnection | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private emptySince: number | undefined;
  private leaving = false;
  private degradedNotified = false;
  private lines = 0;
  private endSignal: () => void = () => undefined;
  private leftSignal: () => void = () => undefined;
  /** Resolves once teardown finished, so a replacement session can wait for the voice slot. */
  public readonly ended: Promise<void>;
  /** Resolves as soon as leave() starts, so a pending join handshake stops waiting. */
  private readonly left: Promise<void>;

  public constructor(private readonly options: ChannelSessionOptions) {
    this.ended = new Promise((resolve) => {
      this.endSignal = resolve;
    });
    this.left = new Promise((resolve) => {
      this.leftSignal = resolve;
    });
    this.log = options.logger.child({ channelId: options.channel.id, guildId: options.channel.guild.id });
    this.writer = new ChannelWriter({
      channel: options.textChannel,
      logger: this.log,
      intervalMs: options.config.editIntervalMs,
      jitterMs: options.config.editJitterMs,
    });
  }

  public get channelId(): string {
    return this.options.channel.id;
  }

  public get guildId(): string {
    return this.options.channel.guild.id;
  }

  /** False once the session has started tearing down; callers treat it as stale. */
  public get active(): boolean {
    return !this.leaving;
  }

  /** Joins the channel and starts following speakers. Throws when the join fails. */
  public async start(): Promise<void> {
    const me = this.options.channel.guild.members.me;
    if (me) {
      const missing = missingVoicePermissions(this.options.channel, me);
      if (missing.length > 0) throw new Error(`missing permissions: ${missing.join(", ")}`);
    }

    const existing = getVoiceConnection(this.options.channel.guild.id);
    if (existing && existing.joinConfig.channelId !== this.options.channel.id) existing.destroy();

    const connection = joinVoiceChannel({
      channelId: this.options.channel.id,
      guildId: this.options.channel.guild.id,
      adapterCreator: this.options.channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: true,
    });
    this.connection = connection;
    connection.on(VoiceConnectionStatus.Disconnected, () => {
      void this.handleDisconnected();
    });

    // destroy() throws on an already-destroyed connection and does not reject
    // entersState, so race the handshake against our own leave signal.
    const ready = entersState(connection, VoiceConnectionStatus.Ready, 20_000).then(
      () => true,
      () => false,
    );
    const joined = await Promise.race([ready, this.left.then(() => false)]);
    if (!joined) {
      if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
      if (this.leaving) return;
      throw new Error("could not establish the voice connection");
    }
    if (this.leaving) return;

    if (this.options.channel.type === ChannelType.GuildStageVoice) {
      await me?.voice.setSuppressed(false).catch(() => undefined);
      if (this.leaving) return;
    }

    connection.receiver.speaking.on("start", this.speaking);
    this.idleTimer = setInterval(() => this.checkIdle(), IDLE_POLL_MS);
    this.idleTimer.unref?.();

    this.log.info({ textChannelId: this.options.textChannel.id }, "transcription session started");
    await this.writer.system(
      `🎙️ **Live transcript started** — speakers in this channel are transcribed below, one line per utterance. \`${this.options.config.commandPrefix}leave\` stops it.`,
    );
  }

  /** Stops the session, closes sockets, and posts a summary. */
  public async leave(reason: string): Promise<void> {
    if (this.leaving) return;
    this.leaving = true;
    this.leftSignal();
    clearInterval(this.idleTimer);
    this.idleTimer = undefined;
    this.connection?.receiver.speaking.off("start", this.speaking);
    for (const stream of this.activeStreams.values()) {
      try {
        stream.destroy();
      } catch {
        // Already gone.
      }
    }
    this.activeStreams.clear();
    await Promise.all([...this.pipelines.values()].map((pipeline) => pipeline.dispose().catch(() => undefined)));
    this.pipelines.clear();
    try {
      this.connection?.destroy();
    } catch {
      // Already gone.
    }
    this.connection = undefined;

    const minutes = Math.max(1, Math.round((Date.now() - this.startedAt) / 60_000));
    await this.writer.system(
      `🔇 **Transcript stopped** (${reason}) — ${this.lines} line${this.lines === 1 ? "" : "s"} from ${this.seenSpeakers.size} speaker${this.seenSpeakers.size === 1 ? "" : "s"} over ~${minutes} min.`,
    );
    this.log.info({ reason, lines: this.lines, speakers: this.seenSpeakers.size }, "transcription session stopped");
    this.endSignal();
    this.options.onEnded?.();
  }

  /** Applies a gateway voice-state change to pipelines and idle tracking. */
  public handleVoiceState(oldState: VoiceState, newState: VoiceState): void {
    const userId = newState.id;

    if (userId === this.options.client.user?.id) {
      if (newState.channelId !== this.options.channel.id) void this.leave("bot moved out of the channel");
      return;
    }
    if (oldState.channelId === this.options.channel.id && newState.channelId !== this.options.channel.id) {
      void this.dropSpeaker(userId);
    }
    if (newState.channelId === this.options.channel.id) this.emptySince = undefined;
  }

  /** Forgets a member: closes the socket and any in-flight utterance. */
  public async dropSpeaker(userId: string): Promise<void> {
    const stream = this.activeStreams.get(userId);
    this.activeStreams.delete(userId);
    try {
      stream?.destroy();
    } catch {
      // Already gone.
    }
    const pipeline = this.pipelines.get(userId);
    this.pipelines.delete(userId);
    await pipeline?.dispose().catch(() => undefined);
  }

  private handleSpeakerStart(userId: string): void {
    if (this.leaving || this.activeStreams.has(userId)) return;
    const member = this.options.channel.members.get(userId) ?? this.options.channel.guild.members.cache.get(userId);
    if (!member) {
      this.log.debug({ userId }, "speaker is not in the member cache; skipping until the next utterance");
      return;
    }
    if (member.user.bot) return;

    const pipeline = this.resolvePipeline(member);

    let stream: AudioReceiveStream;
    try {
      stream = this.connection!.receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: RECEIVER_SILENCE_MS },
      });
    } catch (error) {
      this.log.warn({ err: error, userId }, "audio subscription failed");
      return;
    }

    const decoder = new prism.opus.Decoder({ rate: 48_000, channels: 2, frameSize: DECODER_FRAME_SIZE });
    this.activeStreams.set(userId, stream);
    stream.pipe(decoder);

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (this.activeStreams.get(userId) !== stream) return;
      this.activeStreams.delete(userId);
      pipeline.endStream();
      decoder.destroy();
      try {
        stream.destroy();
      } catch {
        // Already gone.
      }
      // The stream can end on the same tick a new utterance begins; the library
      // only re-emits "start" after a >100 ms packet gap, so resubscribe here.
      if (!this.leaving && this.connection?.receiver.speaking.users.has(userId)) {
        setImmediate(() => this.handleSpeakerStart(userId));
      }
    };

    decoder.on("data", (pcm: Buffer) => pipeline.pushDecoded(pcm));
    decoder.once("error", (error) => {
      this.log.warn({ err: error, userId }, "opus decode failed");
      release();
    });
    decoder.once("close", release);
    decoder.once("end", release);
    stream.once("error", (error) => {
      this.log.warn({ err: error, userId }, "audio receive failed");
      release();
    });
    stream.once("end", release);
  }

  private resolvePipeline(member: GuildMember): SpeakerPipeline {
    const existing = this.pipelines.get(member.id);
    if (existing) return existing;

    if (this.pipelines.size >= this.options.config.maxConcurrentSpeakers) {
      const oldest = this.pipelines.keys().next();
      if (!oldest.done) void this.dropSpeaker(oldest.value);
    }

    const pipeline = new SpeakerPipeline({
      userId: member.id,
      displayName: member.displayName || member.user.username,
      avatarUrl: member.displayAvatarURL({ size: 64 }),
      color: this.colorFor(member.id),
      writer: this.writer,
      stt: this.options.config.stt,
      vad: this.options.config.vad,
      logger: this.log,
      onDegraded: (reason) => this.notifyDegraded(member.id, reason),
      onLine: () => {
        this.lines += 1;
      },
    });
    this.pipelines.set(member.id, pipeline);
    this.seenSpeakers.add(member.id);
    return pipeline;
  }

  private colorFor(userId: string): number {
    let color = this.speakerColors.get(userId);
    if (color === undefined) {
      color = SPEAKER_COLORS[this.speakerColors.size % SPEAKER_COLORS.length]!;
      this.speakerColors.set(userId, color);
    }
    return color;
  }

  private notifyDegraded(userId: string, reason: string): void {
    if (this.degradedNotified) return;
    this.degradedNotified = true;
    this.log.warn({ userId, reason }, "speaker transcription gave up");
    void this.writer.system(
      `⚠️ Transcription for <@${userId}> keeps failing (${reason}); the rest of the channel keeps streaming.`,
    );
  }

  private async handleDisconnected(): Promise<void> {
    const connection = this.connection;
    if (!connection || this.leaving) return;
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
      this.log.info({}, "voice connection is reconnecting");
    } catch {
      await this.leave("voice connection lost");
    }
  }

  private checkIdle(): void {
    if (this.leaving) return;
    const humans = this.options.channel.members.filter((member) => !member.user.bot).size;
    if (humans > 0) {
      this.emptySince = undefined;
      return;
    }
    this.emptySince ??= Date.now();
    if (Date.now() - this.emptySince >= this.options.config.idleLeaveMs) void this.leave("channel empty");
  }
}
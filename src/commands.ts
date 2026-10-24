import {
  ChannelType,
  PermissionsBitField,
  type Client,
  type Guild,
  type GuildMember,
  type Message,
  type VoiceBasedChannel,
} from "discord.js";
import type { Logger } from "./logger.js";
import type { AppConfig } from "./config.js";
import { ChannelSession, missingVoicePermissions } from "./voice/channel-session.js";
import type { SendableChannel } from "./discord-types.js";

/**
 * `!join`, `!leave`, `!status`.
 *
 * One session per guild: `!join` from another channel moves the bot instead of
 * opening a second session, so a guild never consumes more than one voice slot
 * per bot account.
 */

export interface CommandContext {
  client: Client;
  config: AppConfig;
  logger: Logger;
  sessions: Map<string, ChannelSession>;
}

export const HELP_TEXT = [
  "**Live transcript bot**",
  "- `!join` — join your voice channel and stream a transcript into its text chat",
  "- `!join #text-channel` — same, but post into another channel",
  "- `!leave` — stop and summarise",
  "- `!status` — show what is running",
].join("\n");

const TEXT_REQUIRED: bigint[] = [
  PermissionsBitField.Flags.ViewChannel,
  PermissionsBitField.Flags.SendMessages,
  PermissionsBitField.Flags.EmbedLinks,
  PermissionsBitField.Flags.ReadMessageHistory,
];

export async function handleMessage(message: Message, context: CommandContext): Promise<void> {
  if (!message.inGuild() || message.author.bot) return;
  if (context.config.guildAllowlist.size > 0 && !context.config.guildAllowlist.has(message.guildId)) return;

  const prefix = context.config.commandPrefix;
  if (!message.content.startsWith(prefix)) return;
  const [rawCommand, ...args] = message.content.slice(prefix.length).trim().split(/\s+/);
  const command = rawCommand?.toLowerCase();
  if (!command) return;

  if (!mayControl(message.member, context.config)) {
    if (command === "join" || command === "leave") {
      await message.reply(`Only members with <@&${context.config.controllerRoleId}> may control the bot.`);
    }
    return;
  }

  try {
    if (command === "join") {
      await handleJoin(message, args, context);
      return;
    }
    if (command === "leave" || command === "stop") {
      await handleLeave(message, context);
      return;
    }
    if (command === "status") {
      await handleStatus(message, context);
      return;
    }
    if (command === "help") {
      await message.reply(HELP_TEXT);
    }
  } catch (error) {
    context.logger.error({ err: error, command }, "command failed");
    await message.reply(`⚠️ ${error instanceof Error ? error.message : String(error)}`).catch(() => undefined);
  }
}

function mayControl(member: GuildMember | null, config: AppConfig): boolean {
  if (!config.controllerRoleId) return true;
  if (!member) return false;
  if (member.permissions.has(PermissionsBitField.Flags.ManageGuild)) return true;
  return member.roles.cache.has(config.controllerRoleId);
}

async function handleJoin(message: Message, args: readonly string[], context: CommandContext): Promise<void> {
  if (!message.inGuild() || !message.member) return;
  const voiceChannel = message.member.voice.channel;
  if (!voiceChannel) {
    await message.reply("Join a voice channel first, then run the command again.");
    return;
  }

  const me = message.guild.members.me;
  if (me) {
    const missing = missingVoicePermissions(voiceChannel, me);
    if (missing.length > 0) {
      await message.reply(`I am missing these permissions in **${voiceChannel.name}**: ${missing.join(", ")}`);
      return;
    }
  }

  const target = resolveTextTarget(message, voiceChannel, args[0]);
  if (!target) {
    await message.reply("Both of us need to be able to see and post in the target text channel.");
    return;
  }

  const existing = context.sessions.get(message.guildId);
  if (existing?.active && existing.channelId === voiceChannel.id) {
    await message.reply("Already transcribing this channel.");
    return;
  }

  await startSession(context, voiceChannel, target);

  const where = target.id === voiceChannel.id ? "this voice channel's text chat" : `<#${target.id}>`;
  await message.reply(`🔴 Listening in **${voiceChannel.name}**, transcribing into ${where}.`);
}

/**
 * Opens (or replaces) the session for a guild voice channel. Callers resolve the
 * text target first; this never posts anything itself.
 */
export async function startSession(
  context: CommandContext,
  voiceChannel: VoiceBasedChannel,
  target: SendableChannel,
): Promise<ChannelSession> {
  const guildId = voiceChannel.guild.id;
  const running = context.sessions.get(guildId);
  if (running) {
    if (running.active && running.channelId === voiceChannel.id) return running;
    if (running.active) await running.leave("moved to another channel");
    await running.ended;
    forget(context.sessions, guildId, running);
  }

  const session = new ChannelSession({
    channel: voiceChannel,
    textChannel: target,
    client: context.client,
    config: context.config,
    logger: context.logger,
    onEnded: () => {
      if (context.sessions.get(guildId) === session) context.sessions.delete(guildId);
    },
  });

  context.sessions.set(guildId, session);
  try {
    await session.start();
  } catch (error) {
    forget(context.sessions, guildId, session);
    throw error;
  }
  return session;
}

/** `!join`-equivalent used at startup when AUTO_JOIN_CHANNEL_ID is set. */
export async function autoJoin(context: CommandContext): Promise<void> {
  const channelId = context.config.autoJoinChannelId;
  if (!channelId) return;
  const channel = await context.client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isVoiceBased()) {
    context.logger.warn({ channelId }, "AUTO_JOIN_CHANNEL_ID is not a voice channel");
    return;
  }
  if (context.config.guildAllowlist.size > 0 && !context.config.guildAllowlist.has(channel.guild.id)) {
    context.logger.warn({ channelId, guildId: channel.guild.id }, "AUTO_JOIN_CHANNEL_ID is in a guild outside GUILD_ID; not joining");
    return;
  }
  const me = channel.guild.members.me;
  if (me) {
    const missing = missingVoicePermissions(channel, me);
    if (missing.length > 0) {
      context.logger.warn({ channelId, missing }, "cannot auto-join, permissions missing");
      return;
    }
  }
  if (!canPost(channel, channel.guild)) {
    context.logger.warn({ channelId }, "cannot auto-join, no permission to post in the voice channel");
    return;
  }
  await startSession(context, channel, channel);
  context.logger.info({ channelId }, "auto-joined voice channel");
}

function resolveTextTarget(
  message: Message<true>,
  voiceChannel: NonNullable<GuildMember["voice"]["channel"]>,
  argument: string | undefined,
): SendableChannel | undefined {
  if (!argument) {
    if (canPost(voiceChannel, message.guild)) return voiceChannel;
    return undefined;
  }
  const mention = argument.match(/^<#(\d{5,25})>$/)?.[1] ?? (/\d{5,25}/.test(argument) ? argument.replace(/\D/g, "") : undefined);
  const channel = mention ? message.guild.channels.cache.get(mention) : undefined;
  if (!channel) return undefined;
  if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildVoice && channel.type !== ChannelType.GuildAnnouncement) {
    return undefined;
  }
  // The caller must be allowed to post there too, or !join could stream a
  // conversation into a channel they (and the speakers) cannot see.
  const caller = message.member;
  const callerMayPost = caller !== null && channel.permissionsFor(caller).has([PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages]);
  return callerMayPost && canPost(channel, message.guild) ? (channel as unknown as SendableChannel) : undefined;
}

function canPost(channel: { permissionsFor(member: GuildMember): Readonly<{ has(flags: bigint[]): boolean }> }, guild: Guild): boolean {
  const me = guild.members.me;
  if (!me) return true;
  return channel.permissionsFor(me).has(TEXT_REQUIRED);
}

async function handleLeave(message: Message, context: CommandContext): Promise<void> {
  if (!message.inGuild()) return;
  const session = context.sessions.get(message.guildId);
  if (!session) {
    await message.reply("Not in a voice channel right now.");
    return;
  }
  await session.leave(`requested by ${message.author.username}`);
  forget(context.sessions, message.guildId, session);
  await message.reply("Stopped transcribing.");
}

async function handleStatus(message: Message, context: CommandContext): Promise<void> {
  if (!message.inGuild()) return;
  const session = context.sessions.get(message.guildId);
  if (!session) {
    await message.reply("Not transcribing anything in this server.");
    return;
  }
  await message.reply(`Transcribing <#${session.channelId}>.`);
}

/** Removes a session only if the map still points at it; a newer session must survive. */
function forget(sessions: Map<string, ChannelSession>, guildId: string, session: ChannelSession): void {
  if (sessions.get(guildId) === session) sessions.delete(guildId);
}

/** Leaves every session; used on shutdown. */
export async function leaveAll(context: CommandContext): Promise<void> {
  await Promise.all([...context.sessions.values()].map((session) => session.leave("bot restarting").catch(() => undefined)));
  context.sessions.clear();
}
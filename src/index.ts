import "dotenv/config";
import { Client, GatewayIntentBits, OAuth2Scopes, PermissionFlagsBits, type VoiceState } from "discord.js";
import { ConfigError, loadConfig, type AppConfig } from "./config.js";
import { createLogger, type Logger } from "./logger.js";
import { autoJoin, handleMessage, leaveAll, type CommandContext } from "./commands.js";
import type { ChannelSession } from "./voice/channel-session.js";

const INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildVoiceStates,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
];

/** Everything the bot needs; join and the writer check these per channel at runtime. */
const INVITE_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.Connect,
  PermissionFlagsBits.Speak,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.ReadMessageHistory,
];

async function main(): Promise<void> {
  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n\nCopy .env.example to .env and fill it in.\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const logger = createLogger({ level: config.logLevel });
  const client = new Client({ intents: INTENTS });
  const sessions = new Map<string, ChannelSession>();
  const context: CommandContext = { client, config, logger, sessions };

  client.once("clientReady", (ready) => {
    logger.info({ user: ready.user.tag, guilds: ready.guilds.cache.size }, "bot online");
    logger.info(
      { invite: ready.generateInvite({ scopes: [OAuth2Scopes.Bot], permissions: INVITE_PERMISSIONS }) },
      "invite url (View Channels, Connect, Speak, Send Messages, Embed Links, Read Message History)",
    );
    if (config.autoJoinChannelId) {
      void autoJoin(context).catch((error: unknown) => logger.error({ err: error }, "auto-join failed"));
    }
  });

  client.on("messageCreate", (message) => {
    void handleMessage(message, context).catch((error: unknown) => logger.error({ err: error }, "unhandled command error"));
  });

  client.on("voiceStateUpdate", (oldState: VoiceState, newState: VoiceState) => {
    const session = sessions.get(newState.guild.id) ?? sessions.get(oldState.guild.id);
    session?.handleVoiceState(oldState, newState);
  });

  client.on("channelDelete", (channel) => {
    const guildId = (channel as { guildId?: string | null }).guildId ?? "";
    const session = sessions.get(guildId);
    if (session && session.channelId === channel.id) {
      sessions.delete(session.guildId);
      void session.leave("voice channel deleted");
    }
  });

  client.on("error", (error) => logger.error({ err: error }, "gateway error"));
  client.on("shardDisconnect", (event) => logger.warn({ code: event.code }, "gateway disconnected"));

  installShutdown(client, context, logger);

  await client.login(config.discordToken);
}

function installShutdown(client: Client, context: CommandContext, logger: Logger): void {
  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "shutting down");
    const deadline = setTimeout(() => process.exit(1), 15_000);
    deadline.unref();
    await leaveAll(context).catch(() => undefined);
    client.destroy();
    clearTimeout(deadline);
    logger.info({}, "shutdown complete");
    process.exit(0);
  };
  process.once("SIGINT", () => void stop("SIGINT"));
  process.once("SIGTERM", () => void stop("SIGTERM"));
  process.on("unhandledRejection", (reason) => logger.error({ err: reason }, "unhandled rejection"));
  process.on("uncaughtException", (error) => logger.error({ err: error }, "uncaught exception"));
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
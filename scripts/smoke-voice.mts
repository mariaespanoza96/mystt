/** Live voice smoke test: join a real channel, hold the connection, leave. */
import "dotenv/config";
import { Client, GatewayIntentBits } from "discord.js";
import { VoiceConnectionStatus, getVoiceConnection } from "@discordjs/voice";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { ChannelSession } from "../src/voice/channel-session.js";

const cfg = loadConfig();
const logger = createLogger({ level: "info" });

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
client.once("clientReady", async (ready) => {
  const guild = await ready.guilds.fetch(process.env.SMOKE_GUILD ?? [...ready.guilds.cache.keys()][0]!);
  const channels = await guild.channels.fetch();
  const wanted = process.env.SMOKE_CHANNEL;
  if (!wanted) throw new Error("set SMOKE_CHANNEL to the name of a voice channel to join");
  const channel = channels.find((c) => c?.isVoiceBased() && c.name === wanted);
  if (!channel || !channel.isVoiceBased()) throw new Error(`voice channel ${wanted} not found`);
  console.log("joining", channel.name, channel.id);

  const session = new ChannelSession({
    channel,
    textChannel: channel as never,
    client: ready as never,
    config: cfg,
    logger,
  });
  await session.start();
  const connection = getVoiceConnection(guild.id)!;
  await new Promise((resolve) => setTimeout(resolve, 3000));
  console.log("connection status:", connection.state.status, "listener:", connection.receiver.speaking.listenerCount("start"));
  const ok = connection.state.status === VoiceConnectionStatus.Ready && connection.receiver.speaking.listenerCount("start") === 1;
  await session.leave("smoke test");
  await new Promise((resolve) => setTimeout(resolve, 1500));
  console.log("RESULT:", ok ? "PASS" : "FAIL");
  await client.destroy();
  process.exit(ok ? 0 : 1);
});
await client.login(cfg.discordToken);

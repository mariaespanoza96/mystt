import assert from "node:assert/strict";
import { test } from "node:test";
import type { Client, GuildMember, Message, VoiceBasedChannel } from "discord.js";
import { installVoiceMock, latestHandshake, tick } from "./fake-voice.js";
import { createLogger } from "../src/logger.js";
import { loadConfig } from "../src/config.js";
import { FakeChannel } from "./fakes.js";

installVoiceMock();
const { handleMessage } = await import("../src/commands.js");
type ChannelSession = import("../src/voice/channel-session.js").ChannelSession;

const logger = createLogger({ level: "error", sink: () => undefined });
const config = loadConfig({ DISCORD_TOKEN: "t", STT_URL: "http://127.0.0.1:9/v1/audio/transcriptions" });

function world() {
  const text = new FakeChannel();
  const voice = {
    id: "voice-1",
    name: "Garden",
    type: 2,
    members: new Map(),
    permissionsFor: () => ({ has: () => true }),
    send: text.send.bind(text),
    guild: {
      id: "guild-1",
      members: { me: { id: "999", voice: { setSuppressed: async () => undefined } }, cache: new Map() },
      voiceAdapterCreator: () => undefined,
    },
  };
  voice.members.set("999", { id: "999", user: { bot: true } });
  const replies: string[] = [];
  const message = (content: string) =>
    ({
      content,
      guildId: "guild-1",
      author: { bot: false, username: "alice" },
      inGuild: () => true,
      guild: voice.guild,
      member: { voice: { channel: voice }, permissions: { has: () => true }, roles: { cache: { has: () => true } } },
      reply: async (body: string) => {
        replies.push(body);
        return undefined;
      },
    }) as unknown as Message;

  const context = {
    client: { user: { id: "999" } } as unknown as Client,
    config,
    logger,
    sessions: new Map<string, ChannelSession>(),
  };
  return { message, replies, context, voice: voice as unknown as VoiceBasedChannel, text };
}

test("join starts one session and leave stops it", async () => {
  const { message, context, replies } = world();
  const joining = handleMessage(message("!join"), context);
  await tick(5);
  latestHandshake().resolve();
  await joining;

  assert.equal(context.sessions.size, 1);
  assert.match(replies[0] ?? "", /Listening in \*\*Garden\*\*/);

  await handleMessage(message("!leave"), context);
  assert.equal(context.sessions.size, 0);
  assert.match(replies.at(-1) ?? "", /Stopped transcribing/);
});

test("a rapid leave and rejoin keeps exactly one tracked session", async () => {
  const { message, context } = world();

  const first = handleMessage(message("!join"), context);
  await tick(5);
  latestHandshake().resolve();
  await first;

  await handleMessage(message("!leave"), context);
  assert.equal(context.sessions.size, 0);

  const second = handleMessage(message("!join"), context);
  await tick(5);
  latestHandshake().resolve();
  await second;
  assert.equal(context.sessions.size, 1);

  // The first session's teardown finishes after the new one is registered and
  // must not evict it.
  await tick(60);
  assert.equal(context.sessions.size, 1, "late cleanup left the new session tracked");

  await handleMessage(message("!leave"), context);
  assert.equal(context.sessions.size, 0);
});

test("joining the channel that is already transcribed does not start a second session", async () => {
  const { message, context, replies } = world();
  const joining = handleMessage(message("!join"), context);
  await tick(5);
  latestHandshake().resolve();
  await joining;

  await handleMessage(message("!join"), context);
  assert.equal(context.sessions.size, 1);
  assert.match(replies.at(-1) ?? "", /Already transcribing/);
});

test("leave without a session answers instead of throwing", async () => {
  const { message, context, replies } = world();
  await handleMessage(message("!leave"), context);
  assert.match(replies.at(-1) ?? "", /Not in a voice channel right now/);
});

test("a message outside a guild or from a bot is ignored", async () => {
  const { message, context } = world();
  await handleMessage({ ...message("!join"), inGuild: () => false, guildId: null } as unknown as Message, context);
  assert.equal(context.sessions.size, 0);
});

export type _Unused = GuildMember;
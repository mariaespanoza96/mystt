import assert from "node:assert/strict";
import { test } from "node:test";
import type { Client, GuildMember, VoiceBasedChannel, VoiceState } from "discord.js";
import { createLogger } from "../src/logger.js";
import { loadConfig } from "../src/config.js";
import { ChannelSession } from "../src/voice/channel-session.js";
import { FakeChannel } from "./fakes.js";

const logger = createLogger({ level: "error", sink: () => undefined });
const config = loadConfig({ DISCORD_TOKEN: "t" });
const BOT_ID = "999";

function fakeVoiceChannel(members: string[] = []) {
  const map = new Map<string, unknown>(members.map((id) => [id, { id, user: { bot: false } }]));
  return {
    id: "voice-1",
    type: 2,
    members: map,
    permissionsFor: () => ({ has: () => true }),
    guild: {
      id: "guild-1",
      members: { me: { id: BOT_ID, voice: { setSuppressed: async () => undefined } }, cache: new Map() },
      voiceAdapterCreator: () => undefined,
    },
  };
}

function build(members: string[] = []) {
  const text = new FakeChannel();
  const ended: number[] = [];
  const session = new ChannelSession({
    channel: fakeVoiceChannel(members) as unknown as VoiceBasedChannel,
    textChannel: text,
    client: { user: { id: BOT_ID } } as unknown as Client,
    config,
    logger,
    onEnded: () => ended.push(Date.now()),
  });
  return { session, text, ended };
}

function voiceState(userId: string, channelId: string | null): VoiceState {
  return { id: userId, channelId } as unknown as VoiceState;
}

test("is active until it is asked to leave", () => {
  const { session } = build();
  assert.equal(session.active, true);
});

test("leave posts one summary, notifies the registry once, and is idempotent", async () => {
  const { session, text, ended } = build();
  await session.leave("test");
  await session.leave("again");
  await session.ended;

  assert.equal(session.active, false);
  assert.equal(ended.length, 1);
  assert.equal(text.sent.length, 1);
  assert.match(text.sent[0]!.content, /\*\*Transcript stopped\*\* \(test\)/);
});

test("a member moving out of the channel gets their pipeline disposed", async () => {
  const { session } = build(["member-1"]);
  let disposed = 0;
  const internals = session as unknown as { pipelines: Map<string, { dispose(): Promise<void> }> };
  internals.pipelines.set("member-1", { dispose: async () => void (disposed += 1) });

  session.handleVoiceState(voiceState("member-1", "voice-1"), voiceState("member-1", "voice-2"));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(disposed, 1);
  assert.equal(internals.pipelines.size, 0);
});

test("a member moving into the channel does not drop anyone", async () => {
  const { session } = build([]);
  const internals = session as unknown as { pipelines: Map<string, unknown> };
  internals.pipelines.set("member-2", { dispose: async () => undefined });
  session.handleVoiceState(voiceState("member-2", "voice-2"), voiceState("member-2", "voice-1"));
  assert.equal(internals.pipelines.size, 1);
});

test("the bot being moved out ends the session", async () => {
  const { session, ended } = build();
  session.handleVoiceState(voiceState(BOT_ID, "voice-1"), voiceState(BOT_ID, "voice-9"));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(ended.length, 1);
  assert.equal(session.active, false);
});

test("dropping an unknown speaker is harmless", async () => {
  const { session } = build();
  await session.dropSpeaker("ghost");
  assert.equal(session.active, true);
});

// Keep the unused-import checker honest for the member type used in casts.
export type _Member = GuildMember;
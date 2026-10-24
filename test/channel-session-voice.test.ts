import assert from "node:assert/strict";
import { test } from "node:test";
import type { Client, VoiceBasedChannel } from "discord.js";
import { installVoiceMock, latestConnection, latestHandshake, tick } from "./fake-voice.js";
import { createLogger } from "../src/logger.js";
import { loadConfig } from "../src/config.js";
import { FakeChannel } from "./fakes.js";

installVoiceMock();
const { ChannelSession } = await import("../src/voice/channel-session.js");

const logger = createLogger({ level: "error", sink: () => undefined });
const config = loadConfig({ DISCORD_TOKEN: "t", STT_URL: "http://127.0.0.1:9/v1/audio/transcriptions" });
const BOT_ID = "999";

function build(members: string[] = []) {
  const text = new FakeChannel();
  const ended: number[] = [];
  const channel = {
    id: "voice-1",
    name: "Garden",
    type: 2,
    members: new Map(members.map((id) => [id, { id, user: { bot: false }, displayName: id, displayAvatarURL: () => `https://cdn.example/${id}.png` }])),
    permissionsFor: () => ({ has: () => true }),
    guild: {
      id: "guild-1",
      members: { me: { id: BOT_ID, voice: { setSuppressed: async () => undefined } }, cache: new Map() },
      voiceAdapterCreator: () => undefined,
    },
  };
  const session = new ChannelSession({
    channel: channel as unknown as VoiceBasedChannel,
    textChannel: text,
    client: { user: { id: BOT_ID } } as unknown as Client,
    config,
    logger,
    onEnded: () => ended.push(Date.now()),
  });
  return { session, text, ended };
}

type Internals = {
  pipelines: Map<string, unknown>;
  activeStreams: Map<string, unknown>;
};

test("a leave during the handshake settles start() instead of hanging on the timeout", async () => {
  const { session, ended } = build();
  const starting = session.start();
  await tick(10);

  const before = Date.now();
  await session.leave("test");
  await starting;
  assert.ok(Date.now() - before < 1_500, "start() settled promptly");
  assert.equal(latestConnection().state.status, "destroyed");
  await session.ended;
  assert.equal(ended.length, 1);
});

test("a leave after the handshake detaches the speak listener", async () => {
  const { session, text } = build(["member-1"]);
  const starting = session.start();
  await tick(5);
  latestHandshake().resolve();
  await starting;

  assert.equal(latestConnection().speakingListenerCount(), 1);
  assert.match(text.sent[0]!.content, /Live transcript started/);

  await session.leave("test");
  assert.equal(latestConnection().speakingListenerCount(), 0);
  assert.match(text.sent[1]!.content, /Transcript stopped/);
});

test("a failed handshake rejects start() and destroys the connection", async () => {
  const { session } = build();
  const starting = session.start();
  await tick(5);
  latestHandshake().reject(new Error("timeout"));
  await assert.rejects(starting, /could not establish the voice connection/);
  assert.equal(latestConnection().state.status, "destroyed");
});

test("a decoder error releases the speaker instead of leaking the subscription", async () => {
  const { session } = build(["member-1"]);
  const starting = session.start();
  await tick(5);
  latestHandshake().resolve();
  await starting;

  latestConnection().startSpeaking("member-1");
  await tick(20);
  const internals = session as unknown as Internals;
  assert.equal(internals.activeStreams.size, 1);

  const connection = latestConnection();
  connection.receiver.speaking.users.delete("member-1"); // stopped talking: no resubscribe
  const stream = connection.lastStream!;
  stream.destroy(new Error("boom"));
  await tick(20);
  assert.equal(internals.activeStreams.size, 0, "subscription released on decoder failure");
  assert.equal(stream.destroyed, true);
  assert.equal(connection.subscribed.length, 1, "no resubscribe for a silent member");
  await session.leave("test");
});

test("a released stream resubscribes when the member is still talking", async () => {
  const { session } = build(["member-1"]);
  const starting = session.start();
  await tick(5);
  latestHandshake().resolve();
  await starting;

  const connection = latestConnection();
  connection.startSpeaking("member-1");
  await tick(20);
  connection.lastStream!.destroy(new Error("boom"));
  await tick(20);
  assert.equal(connection.subscribed.length, 2, "second subscription opened");
  assert.equal((session as unknown as Internals).activeStreams.size, 1);
  await session.leave("test");
});

test("the bot being moved drops the session and its speakers", async () => {
  const { session } = build();
  const starting = session.start();
  await tick(5);
  latestHandshake().resolve();
  await starting;

  const state = (id: string, channelId: string | null) => ({ id, channelId }) as never;
  session.handleVoiceState(state(BOT_ID, "voice-1"), state(BOT_ID, "voice-2"));
  await session.ended;
  assert.equal(session.active, false);
});
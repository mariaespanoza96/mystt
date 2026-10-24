import assert from "node:assert/strict";
import { test } from "node:test";
import { createLogger } from "../src/logger.js";
import { ChannelWriter, clamp, splitForContinuation, type SpeakerStyle } from "../src/transcript/writer.js";
import { FakeChannel } from "./fakes.js";

const logger = createLogger({ level: "error", sink: () => undefined });

function writer(channel: FakeChannel, intervalMs = 0) {
  return new ChannelWriter({ channel, logger, intervalMs, jitterMs: 0 });
}

function speaker(name: string): SpeakerStyle {
  return { name, avatarUrl: undefined, color: 0xe74c3c, startedAt: 0 };
}

async function settle(ms = 5): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

test("clamp caps content at the Discord limit", () => {
  assert.equal(clamp("a".repeat(2_500)).length, 2_000);
  assert.equal(clamp("short"), "short");
});

test("splitForContinuation cuts on a word boundary", () => {
  const text = `${"word ".repeat(500)}end`;
  const [head, tail] = splitForContinuation(text, 100);
  assert.ok(head.length <= 100);
  assert.equal(`${head}${tail}`, text);
  assert.ok(!head.endsWith("wor"));
});

test("splitForContinuation leaves short text alone", () => {
  assert.deepEqual(splitForContinuation("hello", 100), ["hello", ""]);
});

test("streamed deltas are coalesced into the newest render", async () => {
  const channel = new FakeChannel();
  const transcript = writer(channel, 40);
  const message = await transcript.open(speaker("Alice"));
  assert.ok(message);
  message.pushDelta("one");
  message.pushDelta(" two");
  message.pushDelta(" three");
  await settle(60);
  assert.equal(message.text, "one two three");
  // Intermediate renders never hit the API: one edit for the coalesced burst.
  assert.equal(channel.sent[0]!.edits, 1);
  assert.equal(channel.sent[0]!.text, "Alice\none two three");
  assert.equal(channel.sent[0]!.embeds[0]!.color, 0xe74c3c);
});

test("finalise writes the text and freezes the message", async () => {
  const channel = new FakeChannel();
  const transcript = writer(channel);
  const message = await transcript.open(speaker("Bob"));
  assert.ok(message);
  assert.equal(channel.sent[0]!.text, "Bob\n…", "placeholder until the first text");
  message.pushDelta("hello");
  await message.finalise();
  assert.equal(channel.sent[0]!.text, "Bob\nhello");
  message.pushDelta(" ignored");
  assert.equal(message.text, "hello");
  await message.finalise();
  assert.equal(channel.sent[0]!.text, "Bob\nhello");
});

test("an empty utterance deletes its placeholder", async () => {
  const channel = new FakeChannel();
  const transcript = writer(channel);
  const message = await transcript.open(speaker("Carol"));
  assert.ok(message);
  await message.finalise();
  assert.equal(channel.sent[0]!.deleted, true);
});

test("mentions in transcripts never ping", async () => {
  const channel = new FakeChannel();
  const calls: unknown[] = [];
  const original = channel.send.bind(channel);
  channel.send = async (options) => {
    calls.push(options);
    return original(options);
  };
  const transcript = writer(channel);
  await transcript.system("@everyone hi");
  assert.deepEqual((calls[0] as { allowedMentions: unknown }).allowedMentions, { parse: [] });
});

test("a failing channel does not reject the caller", async () => {
  const channel = new FakeChannel();
  channel.send = async () => {
    throw new Error("missing access");
  };
  const transcript = writer(channel);
  await transcript.system("hi"); // must not throw
  assert.equal(await transcript.open(speaker("x")), undefined);
});
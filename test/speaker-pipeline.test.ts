import assert from "node:assert/strict";
import { test } from "node:test";
import { createLogger } from "../src/logger.js";
import type { SttConfig } from "../src/config.js";
import { ChannelWriter } from "../src/transcript/writer.js";
import { SpeakerPipeline } from "../src/voice/speaker-pipeline.js";
import { FakeChannel } from "./fakes.js";
import { startFakeWhisper } from "./fake-whisper.js";

const logger = createLogger({ level: "error", sink: () => undefined });

/** One 20 ms decoded frame of loud 48 kHz stereo PCM. */
function loudFrame(amplitude = 12_000): Buffer {
  const frame = Buffer.alloc(3_840);
  for (let index = 0; index < 960; index += 1) {
    frame.writeInt16LE(amplitude, index * 4);
    frame.writeInt16LE(amplitude, index * 4 + 2);
  }
  return frame;
}

const QUIET = Buffer.alloc(3_840);

function sttFor(url: string): SttConfig {
  return {
    backend: "whisper",
    url,
    apiKey: undefined,
    model: undefined,
    language: undefined,
    chunkSeconds: 1,
    timeoutMs: 2_000,
    streamingDelayMs: 480,
    maxSessionSeconds: 240,
  };
}

async function waitFor(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition not met in time");
}

function pipelineFor(
  channel: FakeChannel,
  url: string,
  overrides: Partial<Parameters<typeof makeVad>[0]> = {},
  timings: { graceMs?: number; lateWindowMs?: number } = { graceMs: 150, lateWindowMs: 150 },
) {
  let lines = 0;
  const pipeline = new SpeakerPipeline({
    userId: "42",
    displayName: "Alice",
    avatarUrl: "https://cdn.example/alice.png",
    color: 0x3498db,
    writer: new ChannelWriter({ channel, logger, intervalMs: 0, jitterMs: 0 }),
    stt: sttFor(url),
    vad: makeVad(overrides),
    logger,
    graceMs: timings.graceMs,
    lateWindowMs: timings.lateWindowMs,
    onDegraded: () => undefined,
    onLine: () => {
      lines += 1;
    },
  });
  return { pipeline, lines: () => lines };
}

function makeVad(overrides: { hangoverMs?: number; minUtteranceMs?: number } = {}) {
  return {
    rmsThreshold: 0.01,
    speechFramesToStart: 3,
    hangoverMs: overrides.hangoverMs ?? 100,
    preRollMs: 60,
    maxUtteranceMs: 30_000,
    minUtteranceMs: overrides.minUtteranceMs ?? 100,
    ...overrides,
  };
}

test("streams an utterance into a speaker-labelled message and finalises it", async () => {
  const server = await startFakeWhisper({ reply: (index) => (index === 1 ? " hello there" : undefined) });
  const channel = new FakeChannel();
  const { pipeline, lines } = pipelineFor(channel, server.url);
  try {
    // 1.5 s of speech: the first 1 s chunk is transcribed while the person still talks.
    for (let index = 0; index < 75; index += 1) pipeline.pushDecoded(loudFrame());
    await waitFor(() => channel.sent.length > 0);
    await waitFor(() => (channel.sent[0]?.text ?? "").includes("hello there"));
    const embed = channel.sent[0]!.embeds[0]!;
    assert.equal(channel.sent[0]!.content, "");
    assert.deepEqual(embed.author, { name: "Alice", icon_url: "https://cdn.example/alice.png" });
    assert.equal(embed.description, "hello there");
    assert.equal(embed.color, 0x3498db);
    assert.ok(embed.timestamp);

    for (let index = 0; index < 75; index += 1) pipeline.pushDecoded(loudFrame());
    pipeline.endStream();
    await waitFor(() => lines() === 1);
    assert.equal(channel.sent[0]!.embeds[0]!.description, "hello there", "no duration suffix");
  } finally {
    await pipeline.dispose();
    await server.close();
  }
});

test("pure silence produces no message", async () => {
  const server = await startFakeWhisper();
  const channel = new FakeChannel();
  const { pipeline } = pipelineFor(channel, server.url);
  try {
    for (let index = 0; index < 25; index += 1) pipeline.pushDecoded(QUIET);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(channel.sent.length, 0);
  } finally {
    await pipeline.dispose();
    await server.close();
  }
});

test("a too-short blip is dropped when the model finds no words", async () => {
  const server = await startFakeWhisper();
  const channel = new FakeChannel();
  const { pipeline } = pipelineFor(channel, server.url, { minUtteranceMs: 5_000 });
  try {
    for (let index = 0; index < 25; index += 1) pipeline.pushDecoded(loudFrame());
    pipeline.endStream();
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.ok(channel.sent.every((message) => message.deleted));
  } finally {
    await pipeline.dispose();
    await server.close();
  }
});

test("a slow transcription still lands in its line", async () => {
  // The tail takes far longer than grace plus late window; the line must wait for it.
  const server = await startFakeWhisper({
    reply: (index) => (index === 1 ? "first part" : "late tail"),
    delayMs: (index) => (index === 2 ? 500 : 0),
  });
  const channel = new FakeChannel();
  const { pipeline, lines } = pipelineFor(channel, server.url, {}, { graceMs: 50, lateWindowMs: 50 });
  try {
    for (let index = 0; index < 75; index += 1) pipeline.pushDecoded(loudFrame());
    await waitFor(() => (channel.sent[0]?.text ?? "").includes("first part"));
    pipeline.endStream();
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(lines(), 0);
    await waitFor(() => lines() === 1);
    assert.match(channel.sent[0]!.text, /first part late tail/);
  } finally {
    await pipeline.dispose();
    await server.close();
  }
});

test("a too-short blip is dropped even when the model guesses words", async () => {
  const server = await startFakeWhisper({ reply: (index) => (index === 1 ? " mhm" : undefined) });
  const channel = new FakeChannel();
  const { pipeline } = pipelineFor(channel, server.url, { minUtteranceMs: 60_000 });
  try {
    for (let index = 0; index < 75; index += 1) pipeline.pushDecoded(loudFrame());
    await waitFor(() => (channel.sent[0]?.text ?? "").includes("mhm"));
    pipeline.endStream();
    await waitFor(() => channel.sent.length > 0 && channel.sent.every((message) => message.deleted));
  } finally {
    await pipeline.dispose();
    await server.close();
  }
});

test("long utterances continue across messages without losing a character", async () => {
  // Five 1900-character chunks: two overflows land while the first continuation
  // send is still queued in the writer.
  const chunk = "word ".repeat(380).trim();
  const server = await startFakeWhisper({ reply: (index) => (index <= 5 ? chunk : undefined) });
  const channel = new FakeChannel();
  const { pipeline, lines } = pipelineFor(channel, server.url);
  try {
    for (let index = 0; index < 400; index += 1) pipeline.pushDecoded(loudFrame());
    // Every continuation send is throttled, so wait until the whole burst landed.
    const words = () => channel.sent.reduce((total, message) => total + (message.text.match(/word/g) ?? []).length, 0);
    await waitFor(() => words() >= 1_900, 10_000);
    pipeline.endStream();
    await waitFor(() => lines() >= 1, 5_000);
    const kept = channel.sent
      .filter((message) => !message.deleted)
      .map((message) => message.text)
      .join("\n");
    const keptWords = (kept.match(/word/g) ?? []).length;
    assert.ok(keptWords >= 1_900, `expected the whole burst to survive, kept ${keptWords} of 1900 words`);
    assert.ok(channel.sent.every((message) => message.text.length <= 2_000), "no message exceeds the Discord limit");
  } finally {
    await pipeline.dispose();
    await server.close();
  }
});

test("a line superseded by new speech keeps the text still in flight for it", async () => {
  const server = await startFakeWhisper({ reply: (index) => `utterance ${index}`, delayMs: (index) => (index === 1 ? 300 : 0) });
  const channel = new FakeChannel();
  const { pipeline, lines } = pipelineFor(channel, server.url, {}, { graceMs: 50, lateWindowMs: 50 });
  try {
    for (let index = 0; index < 20; index += 1) pipeline.pushDecoded(loudFrame());
    for (let index = 0; index < 10; index += 1) pipeline.pushDecoded(QUIET);
    // The first tail is still at the model when the speaker starts again.
    for (let index = 0; index < 20; index += 1) pipeline.pushDecoded(loudFrame());
    pipeline.endStream();
    await waitFor(() => lines() === 2);
    const kept = channel.transcriptLines;
    assert.match(kept[0]!, /utterance 1/);
    assert.match(kept[1]!, /utterance 2/);
  } finally {
    await pipeline.dispose();
    await server.close();
  }
});

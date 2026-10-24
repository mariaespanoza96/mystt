import assert from "node:assert/strict";
import { test } from "node:test";
import { createLogger } from "../src/logger.js";
import { loadConfig, type SttConfig } from "../src/config.js";
import { MODEL_FRAME_BYTES } from "../src/audio/resampler.js";
import { RealtimeTranscription } from "../src/stt/realtime-transcription.js";
import { RealtimeTranscriber } from "../src/stt/realtime-transcriber.js";
import { createTranscriber } from "../src/stt/transcriber.js";
import { WhisperTranscriber } from "../src/stt/whisper-transcriber.js";
import { ChannelWriter } from "../src/transcript/writer.js";
import { SpeakerPipeline } from "../src/voice/speaker-pipeline.js";
import { FakeChannel } from "./fakes.js";
import { startFakeStt } from "./fake-stt.js";

const logger = createLogger({ level: "error", sink: () => undefined });

function sttFor(url: string, overrides: Partial<SttConfig> = {}): SttConfig {
  return {
    backend: "realtime",
    url,
    apiKey: "secret",
    model: "test-model",
    language: undefined,
    chunkSeconds: 4,
    timeoutMs: 2_000,
    streamingDelayMs: 480,
    maxSessionSeconds: 240,
    ...overrides,
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

function loudFrame(amplitude = 12_000): Buffer {
  const frame = Buffer.alloc(3_840);
  for (let index = 0; index < 960; index += 1) {
    frame.writeInt16LE(amplitude, index * 4);
    frame.writeInt16LE(amplitude, index * 4 + 2);
  }
  return frame;
}

test("a ws(s) STT_URL selects the Mistral realtime backend, with its key fallback and default model", () => {
  const config = loadConfig({ DISCORD_TOKEN: "t", STT_URL: "wss://api.mistral.ai/v1/audio/transcriptions/realtime", MISTRAL_API_KEY: "m" });
  assert.equal(config.stt.backend, "realtime");
  assert.equal(config.stt.apiKey, "m");
  assert.equal(config.stt.model, "voxtral-mini-transcribe-realtime-3");
  assert.ok(createTranscriber({ userId: "1", stt: config.stt, rmsThreshold: 0.01, logger, onDegraded: () => undefined }) instanceof RealtimeTranscriber);

  const whisper = loadConfig({ DISCORD_TOKEN: "t", MISTRAL_API_KEY: "m" });
  assert.equal(whisper.stt.backend, "whisper");
  assert.equal(whisper.stt.apiKey, undefined, "a Mistral key is never sent to a whisper server");
  assert.ok(createTranscriber({ userId: "1", stt: whisper.stt, rmsThreshold: 0.01, logger, onDegraded: () => undefined }) instanceof WhisperTranscriber);
});

test("the realtime backend needs a key and a valid streaming delay", () => {
  assert.throws(() => loadConfig({ DISCORD_TOKEN: "t", STT_URL: "wss://example/realtime" }), /STT_API_KEY/);
  assert.throws(() => loadConfig({ DISCORD_TOKEN: "t", STT_URL: "wss://example/realtime", STT_API_KEY: "k", STT_STREAMING_DELAY_MS: "1300" }), /STT_STREAMING_DELAY_MS/);
});

test("the socket client authenticates, configures the session, then streams audio and deltas", async () => {
  const server = await startFakeStt({ deltaForAppend: (index) => (index === 1 ? " hello" : undefined) });
  const deltas: string[] = [];
  const client = new RealtimeTranscription({
    url: server.url,
    apiKey: "secret",
    model: "test-model",
    language: "en",
    streamingDelayMs: 480,
    logger,
    onDelta: (text) => deltas.push(text),
    onDone: () => undefined,
    onError: () => undefined,
    onClose: () => undefined,
  });
  try {
    client.append(Buffer.alloc(MODEL_FRAME_BYTES)); // buffered until the session is ready
    await client.connect();
    const session = server.sessions[0]!;
    assert.equal(session.authorization, "Bearer secret");
    assert.match(session.url, /\?model=test-model$/);
    assert.deepEqual(session.updates[0], {
      audio_format: { encoding: "pcm_s16le", sample_rate: 16_000 },
      target_streaming_delay_ms: 480,
      language: "en",
    });
    await waitFor(() => deltas.length === 1);
    assert.deepEqual(deltas, [" hello"]);
    assert.equal(session.audioBytes, MODEL_FRAME_BYTES);
    await client.end();
    assert.equal(session.ended, true);
  } finally {
    client.close();
    await server.close();
  }
});

test("a rejected session update fails the connect", async () => {
  const server = await startFakeStt({ rejectUpdate: "bad delay" });
  const client = new RealtimeTranscription({
    url: server.url,
    apiKey: "k",
    model: "m",
    language: undefined,
    streamingDelayMs: 480,
    logger,
    onDelta: () => undefined,
    onDone: () => undefined,
    onError: () => undefined,
    onClose: () => undefined,
  });
  try {
    await assert.rejects(client.connect(), /bad delay/);
  } finally {
    client.close();
    await server.close();
  }
});

test("a speaker whose socket keeps failing is degraded once", async () => {
  const server = await startFakeStt({ rejectHandshake: true });
  const reasons: string[] = [];
  const transcriber = new RealtimeTranscriber({
    userId: "1",
    stt: sttFor(server.url),
    rmsThreshold: 0.01,
    logger,
    onDegraded: (reason) => reasons.push(reason),
    maxAttempts: 1,
  });
  try {
    transcriber.begin(() => undefined);
    transcriber.append(Buffer.alloc(MODEL_FRAME_BYTES));
    await waitFor(() => reasons.length === 1, 5_000);
  } finally {
    await transcriber.close();
    await server.close();
  }
});

test("realtime deltas stream into the speaker's line as they arrive, late ones included", async () => {
  const server = await startFakeStt({ deltaForAppend: (index) => (index === 1 ? " hello" : index === 3 ? " there" : undefined) });
  const channel = new FakeChannel();
  let lines = 0;
  const pipeline = new SpeakerPipeline({
    userId: "42",
    displayName: "Alice",
    color: 0x3498db,
    writer: new ChannelWriter({ channel, logger, intervalMs: 0, jitterMs: 0 }),
    stt: sttFor(server.url),
    vad: { rmsThreshold: 0.01, speechFramesToStart: 3, hangoverMs: 100, preRollMs: 60, maxUtteranceMs: 30_000, minUtteranceMs: 100 },
    logger,
    graceMs: 80,
    lateWindowMs: 700,
    onDegraded: () => undefined,
    onLine: () => {
      lines += 1;
    },
  });
  try {
    for (let index = 0; index < 25; index += 1) pipeline.pushDecoded(loudFrame());
    await waitFor(() => (channel.sent[0]?.text ?? "").includes("hello there"));
    pipeline.endStream();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(lines, 0, "dormant, not yet frozen");
    assert.equal(server.sessions[0]!.flushes, 1, "the utterance end flushes the model");
    server.sessions[0]!.delta(" again");
    await waitFor(() => lines === 1);
    assert.equal(channel.sent[0]!.embeds[0]!.description, "hello there again");
  } finally {
    await pipeline.dispose();
    await server.close();
  }
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { createLogger } from "../src/logger.js";
import type { SttConfig } from "../src/config.js";
import { MODEL_FRAME_BYTES } from "../src/audio/resampler.js";
import { cleanTranscript, isStockPhrase, transcribePcm, wav } from "../src/stt/whisper-client.js";
import { WhisperTranscriber, quietestCut, trimSilence } from "../src/stt/whisper-transcriber.js";
import { startFakeWhisper } from "./fake-whisper.js";

const logger = createLogger({ level: "error", sink: () => undefined });

function frame(amplitude: number): Buffer {
  const buffer = Buffer.alloc(MODEL_FRAME_BYTES);
  for (let index = 0; index < MODEL_FRAME_BYTES / 2; index += 1) buffer.writeInt16LE(index % 2 ? amplitude : -amplitude, index * 2);
  return buffer;
}

function sttFor(url: string, overrides: Partial<SttConfig> = {}): SttConfig {
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

test("wav wraps 16 kHz mono and pads short clips to whisper.cpp's 1 s minimum", () => {
  const short = wav(Buffer.alloc(3_200));
  assert.equal(short.subarray(0, 4).toString(), "RIFF");
  assert.equal(short.readUInt32LE(24), 16_000);
  assert.equal(short.readUInt16LE(22), 1);
  assert.ok(short.readUInt32LE(40) >= 32_000);
  const long = wav(Buffer.alloc(64_000));
  assert.equal(long.readUInt32LE(40), 64_000);
});

test("non-speech tags are stripped from transcripts", () => {
  assert.equal(cleanTranscript(" [BLANK_AUDIO]\n"), "");
  assert.equal(cleanTranscript(" Hello there.\n (laughs) The quick [Music] fox.\n"), "Hello there. The quick fox.");
});

test("sends the documented multipart fields and only authenticates when a key is set", async () => {
  const server = await startFakeWhisper({ reply: () => " hi " });
  try {
    assert.equal(await transcribePcm(Buffer.alloc(64_000), { url: server.url, apiKey: undefined, model: undefined, language: undefined, timeoutMs: 2_000 }), "hi");
    await transcribePcm(Buffer.alloc(32_000), { url: server.url, apiKey: "k", model: "whisper-1", language: "en", prompt: "earlier", timeoutMs: 2_000 });
    const [anonymous, keyed] = server.requests;
    assert.equal(anonymous!.authorization, undefined);
    assert.deepEqual(anonymous!.fields, { response_format: "json", temperature: "0", suppress_nst: "true" });
    assert.equal(anonymous!.audioBytes, 64_000);
    assert.equal(keyed!.authorization, "Bearer k");
    assert.deepEqual(keyed!.fields, {
      response_format: "json",
      temperature: "0",
      suppress_nst: "true",
      model: "whisper-1",
      language: "en",
      prompt: "earlier",
    });
  } finally {
    await server.close();
  }
});

test("an HTTP error is reported, not returned as text", async () => {
  const server = await startFakeWhisper({ status: () => 500 });
  try {
    await assert.rejects(
      transcribePcm(Buffer.alloc(32_000), { url: server.url, apiKey: undefined, model: undefined, language: undefined, timeoutMs: 2_000 }),
      /HTTP 500/,
    );
  } finally {
    await server.close();
  }
});

test("chunks are cut at the quietest recent frame", () => {
  const audio = Buffer.concat([...Array.from({ length: 8 }, () => frame(9_000)), frame(10), frame(9_000), frame(9_000)]);
  assert.equal(quietestCut(audio), 9 * MODEL_FRAME_BYTES);
});

test("long utterances are sent in chunks, in order, with earlier text as the prompt", async () => {
  const sent: { bytes: number; prompt: string }[] = [];
  const transcriber = new WhisperTranscriber({
    userId: "1",
    rmsThreshold: 0.01,
    stt: sttFor("http://unused"),
    logger,
    onDegraded: () => undefined,
    transcribe: async (pcm, prompt) => {
      sent.push({ bytes: pcm.length, prompt });
      return `part${sent.length}`;
    },
  });
  const texts: string[] = [];
  try {
    const handle = transcriber.begin((text) => texts.push(text));
    for (let index = 0; index < 25; index += 1) transcriber.append(frame(9_000));
    transcriber.flush();
    assert.ok(handle.pending > 0);
    await waitFor(() => handle.pending === 0);
    assert.deepEqual(texts, ["part1", " part2", " part3"], "later chunks arrive spaced");
    assert.deepEqual(
      sent.map((request) => request.prompt),
      ["", "part1", "part1 part2"],
    );
    const total = sent.reduce((sum, request) => sum + request.bytes, 0);
    assert.equal(total, 25 * MODEL_FRAME_BYTES, "no audio is lost or duplicated across chunks");
  } finally {
    await transcriber.close();
  }
});

test("text goes to the utterance it was spoken in, even when the next one has started", async () => {
  const server = await startFakeWhisper({ reply: (index) => `u${index}`, delayMs: (index) => (index === 1 ? 150 : 0) });
  const transcriber = new WhisperTranscriber({ userId: "1", rmsThreshold: 0.01, stt: sttFor(server.url, { chunkSeconds: 30 }), logger, onDegraded: () => undefined });
  const first: string[] = [];
  const second: string[] = [];
  try {
    transcriber.begin((text) => first.push(text));
    for (let index = 0; index < 3; index += 1) transcriber.append(frame(9_000));
    transcriber.flush();
    const handle = transcriber.begin((text) => second.push(text));
    for (let index = 0; index < 3; index += 1) transcriber.append(frame(9_000));
    transcriber.flush();
    await waitFor(() => handle.pending === 0);
    assert.deepEqual(first, ["u1"]);
    assert.deepEqual(second, ["u2"]);
  } finally {
    await transcriber.close();
    await server.close();
  }
});

test("repeated failures degrade the speaker once", async () => {
  const server = await startFakeWhisper({ status: () => 503 });
  const reasons: string[] = [];
  const transcriber = new WhisperTranscriber({
    userId: "1",
    rmsThreshold: 0.01,
    stt: sttFor(server.url, { chunkSeconds: 30 }),
    logger,
    onDegraded: (reason) => reasons.push(reason),
    maxFailures: 2,
  });
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const handle = transcriber.begin(() => undefined);
      for (let index = 0; index < 3; index += 1) transcriber.append(frame(9_000));
      transcriber.flush();
      await waitFor(() => handle.pending === 0);
    }
    assert.equal(reasons.length, 1);
    assert.match(reasons[0]!, /HTTP 503/);
  } finally {
    await transcriber.close();
    await server.close();
  }
});

test("the quiet tail is trimmed and silent chunks are never sent", () => {
  const speech = Array.from({ length: 5 }, () => frame(9_000));
  const quiet = Array.from({ length: 7 }, () => frame(10));
  const trimmed = trimSilence(Buffer.concat([...speech, ...quiet]), 0.01);
  assert.equal(trimmed?.length, 7 * MODEL_FRAME_BYTES, "speech plus 200 ms of tail");
  assert.equal(trimSilence(Buffer.concat(quiet), 0.01), undefined);
  assert.equal(trimSilence(Buffer.concat([frame(9_000), ...quiet]), 0.01), undefined, "a 100 ms click is noise");
});

test("whisper's stock phrases are recognised only as a whole transcript", () => {
  assert.ok(isStockPhrase("Thank you."));
  assert.ok(isStockPhrase(" you"));
  assert.ok(isStockPhrase("Thanks for watching!"));
  assert.equal(isStockPhrase("Thank you for the help."), false);
  assert.equal(isStockPhrase("Can you hear me?"), false);
});

test("a chunk transcribed as a stock phrase never reaches the line", async () => {
  const texts: string[] = [];
  const transcriber = new WhisperTranscriber({
    userId: "1",
    rmsThreshold: 0.01,
    stt: sttFor("http://unused", { chunkSeconds: 30 }),
    logger,
    onDegraded: () => undefined,
    transcribe: async () => "Thank you.",
  });
  try {
    const handle = transcriber.begin((text) => texts.push(text));
    for (let index = 0; index < 5; index += 1) transcriber.append(frame(9_000));
    transcriber.flush();
    await waitFor(() => handle.pending === 0);
    assert.deepEqual(texts, []);
  } finally {
    await transcriber.close();
  }
});

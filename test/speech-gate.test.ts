import assert from "node:assert/strict";
import { test } from "node:test";
import { SpeechGate, type SpeechGateOptions } from "../src/audio/speech-gate.js";

const FRAME_MS = 20;

function options(overrides: Partial<SpeechGateOptions> = {}): SpeechGateOptions {
  return {
    rmsThreshold: 0.01,
    speechFramesToStart: 3,
    hangoverMs: 100,
    preRollMs: 60,
    minUtteranceMs: 100,
    maxUtteranceMs: 1_000,
    ...overrides,
  };
}

const loud = Buffer.alloc(320, 0x40);
const quiet = Buffer.alloc(320, 0);

/** Feeds frames and returns the emissions. */
function feed(gate: SpeechGate, frames: readonly Buffer[]): ReturnType<SpeechGate["push"]>[] {
  return frames.map((frame) => gate.push(frame, FRAME_MS));
}

test("stays closed on silence", () => {
  const gate = new SpeechGate(options());
  const emissions = feed(gate, Array<Buffer>(10).fill(quiet));
  assert.ok(emissions.every((emission) => !emission.started && emission.emit.length === 0));
  assert.equal(gate.speaking, false);
});

test("opens only after the configured number of loud frames and replays the pre-roll", () => {
  const gate = new SpeechGate(options());
  const [first, second, third] = feed(gate, [loud, loud, loud]);
  assert.equal(first!.started, false);
  assert.equal(second!.started, false);
  assert.equal(third!.started, true);
  // 60 ms pre-roll at 20 ms per frame = the three held frames, including the trigger frame.
  assert.equal(third!.emit.length, 3);
  assert.equal(gate.speaking, true);
});

test("closes after the hangover and reports the duration", () => {
  const gate = new SpeechGate(options({ hangoverMs: 60 }));
  feed(gate, [loud, loud, loud]);
  const emissions = feed(gate, [loud, loud, loud, quiet, quiet, quiet, quiet]);
  const ended = emissions.filter((emission) => emission.ended);
  assert.equal(ended.length, 1);
  const end = ended[0]!;
  assert.equal(end.tooShort, false);
  assert.ok(end.durationMs >= 100);
  assert.equal(gate.speaking, false);
});

test("flags utterances below the minimum length", () => {
  const gate = new SpeechGate(options({ hangoverMs: 20, minUtteranceMs: 500 }));
  feed(gate, [loud, loud, loud]);
  const emissions = feed(gate, [quiet, quiet]);
  const end = emissions.find((emission) => emission.ended);
  assert.equal(end?.tooShort, true);
});

test("force-cuts an utterance that outlives the maximum", () => {
  const gate = new SpeechGate(options({ maxUtteranceMs: 100 }));
  feed(gate, [loud, loud, loud]);
  const emissions = feed(gate, [loud, loud]);
  const end = emissions.find((emission) => emission.ended);
  assert.ok(end);
  assert.equal(end!.durationMs, 100);
  assert.equal(gate.speaking, false);
});

test("end() closes an open utterance from the stream side", () => {
  const gate = new SpeechGate(options());
  feed(gate, [loud, loud, loud]);
  const end = gate.end();
  assert.equal(end.ended, true);
  assert.equal(gate.speaking, false);
});

test("end() on an idle gate is a no-op", () => {
  const gate = new SpeechGate(options());
  assert.equal(gate.end().ended, false);
});

test("pre-roll is bounded", () => {
  const gate = new SpeechGate(options({ preRollMs: 40 }));
  feed(gate, Array<Buffer>(20).fill(quiet));
  const emissions = feed(gate, [loud, loud, loud]);
  const start = emissions.find((emission) => emission.started);
  assert.ok(start);
  assert.ok(start!.emit.length <= 3);
});
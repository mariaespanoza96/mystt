import assert from "node:assert/strict";
import { test } from "node:test";
import { MODEL_SAMPLE_RATE, PcmFrameChunker, Stereo48kToMono16k, rms } from "../src/audio/resampler.js";

/** 20 ms Discord frame: 960 stereo samples of a fixed amplitude sine. */
function stereoFrame(samples: number, amplitude = 8_000, phase = 0): Buffer {
  const buffer = Buffer.alloc(samples * 4);
  for (let index = 0; index < samples; index += 1) {
    const value = Math.round(Math.sin((index + phase) / 12) * amplitude);
    buffer.writeInt16LE(value, index * 4);
    buffer.writeInt16LE(value, index * 4 + 2);
  }
  return buffer;
}

test("downsamples 48 kHz stereo to 16 kHz mono at exactly one third of the frame count", () => {
  const resampler = new Stereo48kToMono16k();
  const output = resampler.push(stereoFrame(960));
  assert.equal(output.length / 2, 320);
  assert.equal(output.length / 2 / MODEL_SAMPLE_RATE * 1000, 20);
});

test("averages the two channels into mono", () => {
  const resampler = new Stereo48kToMono16k();
  const frame = Buffer.alloc(3 * 4);
  frame.writeInt16LE(1_000, 0);
  frame.writeInt16LE(3_000, 2);
  frame.writeInt16LE(1_000, 4);
  frame.writeInt16LE(3_000, 6);
  frame.writeInt16LE(1_000, 8);
  frame.writeInt16LE(3_000, 10);
  const output = resampler.push(frame);
  assert.equal(output.length, 2);
  assert.equal(output.readInt16LE(0), 2_000);
});

test("carries samples across chunk boundaries instead of dropping them", () => {
  const resampler = new Stereo48kToMono16k();
  assert.equal(resampler.push(stereoFrame(2)).length, 0);
  assert.equal(resampler.pendingSamples, 2);
  const output = resampler.push(stereoFrame(1));
  assert.equal(output.length, 2);
  assert.equal(resampler.pendingSamples, 0);
});

test("flush pads the trailing partial group", () => {
  const resampler = new Stereo48kToMono16k();
  resampler.push(stereoFrame(5));
  assert.equal(resampler.pendingSamples, 2);
  const output = resampler.flush();
  assert.equal(output.length, 2);
  assert.equal(resampler.pendingSamples, 0);
});

test("rms follows amplitude", () => {
  const quiet = Buffer.alloc(320);
  const loud = Buffer.alloc(320);
  for (let index = 0; index < 160; index += 1) loud.writeInt16LE(16_384, index * 2);
  assert.equal(rms(quiet), 0);
  assert.ok(Math.abs(rms(loud) - 0.5) < 0.01);
});

test("frame chunker regroups arbitrary writes and keeps the remainder", () => {
  const chunker = new PcmFrameChunker(6);
  assert.deepEqual(chunker.push(Buffer.alloc(2)).length, 0);
  const frames = chunker.push(Buffer.alloc(7));
  assert.equal(frames.length, 1);
  assert.equal(frames[0]!.length, 6);
  assert.equal(chunker.flush()!.length, 3);
  assert.equal(chunker.flush(), undefined);
});
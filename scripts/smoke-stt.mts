/** End-to-end against the real transcription endpoint (STT_URL), without Discord: 48 kHz stereo in, transcript line out. */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { ChannelWriter } from "../src/transcript/writer.js";
import { SpeakerPipeline } from "../src/voice/speaker-pipeline.js";
import { FakeChannel } from "../test/fakes.js";

const env = { ...process.env };
env.DISCORD_TOKEN ??= "smoke";
const cfg = loadConfig(env);
const logger = createLogger({ level: "warn" });

execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", "fixtures/speech.wav", "-ar", "48000", "-ac", "2", "-f", "s16le", "fixtures/speech-48k.pcm"]);
const pcm = readFileSync("fixtures/speech-48k.pcm");
const channel = new FakeChannel();
const pipeline = new SpeakerPipeline({
  userId: "smoke", displayName: "Smoke Tester", color: 0x3498db,
  writer: new ChannelWriter({ channel, logger, intervalMs: 300, jitterMs: 50 }),
  stt: cfg.stt, vad: cfg.vad, logger,
  onDegraded: (reason) => console.log("DEGRADED", reason),
  onLine: () => console.log("LINE FINALISED"),
});
let last = "";
for (let offset = 0; offset + 3840 <= pcm.length; offset += 3840) {
  pipeline.pushDecoded(pcm.subarray(offset, offset + 3840));
  await new Promise((resolve) => setTimeout(resolve, 20));
}
await new Promise((resolve) => setTimeout(resolve, 1500));
pipeline.endStream();
await new Promise((resolve) => setTimeout(resolve, 3000));
await pipeline.dispose();
const lines = channel.transcriptLines;
for (const line of lines) { console.log("---"); console.log(line); last += line; }
console.log("RESULT:", /quick brown fox/i.test(last) ? "PASS" : "FAIL");
process.exit(/quick brown fox/i.test(last) ? 0 : 1);

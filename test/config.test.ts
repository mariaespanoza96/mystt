import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigError, loadConfig } from "../src/config.js";

const BASE = {
  DISCORD_TOKEN: "token",
};

test("applies documented defaults", () => {
  const config = loadConfig({ ...BASE });
  assert.equal(config.commandPrefix, "!");
  assert.equal(config.stt.url, "http://127.0.0.1:8090/v1/audio/transcriptions");
  assert.equal(config.stt.apiKey, undefined);
  assert.equal(config.stt.model, undefined);
  assert.equal(config.stt.chunkSeconds, 4);
  assert.equal(config.stt.timeoutMs, 20_000);
  assert.equal(config.vad.rmsThreshold, 0.012);
  assert.equal(config.idleLeaveMs, 300_000);
  assert.equal(config.guildAllowlist.size, 0);
});

test("passes an optional key and model through for hosted endpoints", () => {
  const config = loadConfig({ ...BASE, STT_API_KEY: "key", STT_MODEL: "whisper-1", STT_LANGUAGE: "auto" });
  assert.equal(config.stt.apiKey, "key");
  assert.equal(config.stt.model, "whisper-1");
  assert.equal(config.stt.language, "auto");
});

test("requires a discord token and an http speech endpoint", () => {
  assert.throws(() => loadConfig({ STT_URL: "wss://api.mistral.ai/v1/audio/transcriptions/realtime" }), (error: unknown) => {
    assert.ok(error instanceof ConfigError);
    assert.equal(error.problems.length, 2);
    return true;
  });
});

test("rejects out-of-range numbers", () => {
  assert.throws(
    () => loadConfig({ ...BASE, STT_CHUNK_SECONDS: "0.5", VAD_RMS_THRESHOLD: "2" }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.problems.length, 2);
      return true;
    },
  );
});

test("rejects a non ISO language and a bad log level", () => {
  assert.throws(() => loadConfig({ ...BASE, STT_LANGUAGE: "english", LOG_LEVEL: "trace" }), ConfigError);
});

test("parses guild and role ids and ignores junk", () => {
  const config = loadConfig({ ...BASE, GUILD_ID: "100000000000000001, nope", CONTROLLER_ROLE_ID: "100000000000000002" });
  assert.deepEqual([...config.guildAllowlist], ["100000000000000001"]);
  assert.equal(config.controllerRoleId, "100000000000000002");
});

test("a malformed role id is reported", () => {
  assert.throws(() => loadConfig({ ...BASE, CONTROLLER_ROLE_ID: "admin" }), ConfigError);
});
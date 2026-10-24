import { isLogLevel, type LogLevel } from "./logger.js";

export class ConfigError extends Error {
  public constructor(public readonly problems: readonly string[]) {
    super(`invalid configuration:\n- ${problems.join("\n- ")}`);
    this.name = "ConfigError";
  }
}

/**
 * `whisper`: an OpenAI-compatible request/response endpoint (http/https URL),
 * e.g. a local whisper.cpp server. `realtime`: the Mistral Voxtral realtime
 * websocket (ws/wss URL), which streams words as they are spoken.
 */
export type SttBackend = "whisper" | "realtime";

export interface SttConfig {
  backend: SttBackend;
  url: string;
  /** Bearer token. Optional for whisper (a local server needs none), required for realtime. */
  apiKey: string | undefined;
  /** Whisper: `model` form field when set. Realtime: the model query parameter. */
  model: string | undefined;
  /** Two-letter code (or `auto` for whisper); unset leaves it to the backend's default. */
  language: string | undefined;
  /** Whisper: long utterances are sent in chunks of about this length so a line fills while the person talks. */
  chunkSeconds: number;
  /** Whisper: per-request timeout. */
  timeoutMs: number;
  /** Realtime: model-side delay before committing words, 80–1200 or 2400. Lower is faster and less accurate. */
  streamingDelayMs: number;
  /** Realtime: a speaker's socket is recycled after this much audio, keeping the model context small. */
  maxSessionSeconds: number;
}

export interface VadConfig {
  /** RMS gate over 0..1; frames below it count as silence. */
  rmsThreshold: number;
  /** Consecutive loud 100 ms frames needed before an utterance opens. */
  speechFramesToStart: number;
  /** Silence needed to close an utterance. */
  hangoverMs: number;
  /** Audio kept ahead of the first detected frame so word onsets are not clipped. */
  preRollMs: number;
  /** Hard cut so one seat cannot hold an utterance open forever. */
  maxUtteranceMs: number;
  /** Utterances shorter than this are treated as noise and dropped. */
  minUtteranceMs: number;
}

export interface AppConfig {
  /** Join this voice channel right after startup (optional, for long-running deployments). */
  autoJoinChannelId: string | undefined;
  discordToken: string;
  commandPrefix: string;
  /** Guild ids the bot answers in; empty means every guild it is invited to. */
  guildAllowlist: ReadonlySet<string>;
  /** Role that may issue !join / !leave; undefined means any member. */
  controllerRoleId: string | undefined;
  /** Leave when nobody else is left in the channel, after this long. */
  idleLeaveMs: number;
  /** Ceiling on members with a live transcription pipeline. */
  maxConcurrentSpeakers: number;
  /** Minimum spacing between two edits of the same transcript message. */
  editIntervalMs: number;
  /** Delay added on top of editIntervalMs for each streamed message, spreading API pressure. */
  editJitterMs: number;
  stt: SttConfig;
  vad: VadConfig;
  logLevel: LogLevel;
}

const DEFAULT_STT_URL = "http://127.0.0.1:8090/v1/audio/transcriptions";
const DEFAULT_REALTIME_MODEL = "voxtral-mini-transcribe-realtime-3";

function str(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

function integer(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
  problems: string[],
): number {
  const raw = str(env, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    problems.push(`${name} must be an integer between ${min} and ${max} (got ${raw})`);
    return fallback;
  }
  return value;
}

function decimal(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
  problems: string[],
): number {
  const raw = str(env, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    problems.push(`${name} must be a number between ${min} and ${max} (got ${raw})`);
    return fallback;
  }
  return value;
}

/** The realtime model only accepts trained delay values: 80–1200, or 2400. */
function streamingDelay(env: NodeJS.ProcessEnv, problems: string[]): number {
  const value = integer(env, "STT_STREAMING_DELAY_MS", 480, 80, 2_400, problems);
  if (value !== 2_400 && (value < 80 || value > 1_200)) {
    problems.push(`STT_STREAMING_DELAY_MS must be between 80 and 1200, or 2400 (got ${value})`);
  }
  return value;
}

function idSet(env: NodeJS.ProcessEnv, name: string): Set<string> {
  const raw = str(env, name);
  if (!raw) return new Set();
  return new Set(
    raw
      .split(/[\s,]+/)
      .map((entry) => entry.trim())
      .filter((entry) => /^\d{5,25}$/.test(entry)),
  );
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const problems: string[] = [];

  const discordToken = str(env, "DISCORD_TOKEN");
  if (!discordToken) problems.push("DISCORD_TOKEN is required");

  const sttUrl = str(env, "STT_URL") ?? DEFAULT_STT_URL;
  const backend: SttBackend = /^wss?:\/\//.test(sttUrl) ? "realtime" : "whisper";
  if (!/^(https?|wss?):\/\/\S+$/.test(sttUrl)) {
    problems.push(`STT_URL must be an http(s) URL (whisper) or a ws(s) URL (Mistral realtime) (got ${sttUrl})`);
  }

  // The Mistral key fallback only applies to Mistral, so it is never sent to a whisper server.
  const apiKey = backend === "realtime" ? (str(env, "STT_API_KEY") ?? str(env, "MISTRAL_API_KEY")) : str(env, "STT_API_KEY");
  if (backend === "realtime" && !apiKey) problems.push("STT_API_KEY (or MISTRAL_API_KEY) is required for the Mistral realtime API");

  const language = str(env, "STT_LANGUAGE");
  const languagePattern = backend === "realtime" ? /^[a-z]{2}$/ : /^([a-z]{2}|auto)$/;
  if (language && !languagePattern.test(language)) {
    problems.push(`STT_LANGUAGE must be a two-letter ISO 639-1 code${backend === "whisper" ? " or auto" : ""}`);
  }

  const roleId = str(env, "CONTROLLER_ROLE_ID");
  if (roleId && !/^\d{5,25}$/.test(roleId)) problems.push("CONTROLLER_ROLE_ID must be a Discord role id");

  const logLevelRaw = str(env, "LOG_LEVEL") ?? "info";
  if (!isLogLevel(logLevelRaw)) problems.push(`LOG_LEVEL must be one of debug, info, warn, error (got ${logLevelRaw})`);

  const prefix = str(env, "COMMAND_PREFIX") ?? "!";
  if (prefix.length > 5) problems.push("COMMAND_PREFIX must be 5 characters or fewer");

  const config: AppConfig = {
    discordToken: discordToken ?? "",
    commandPrefix: prefix,
    guildAllowlist: idSet(env, "GUILD_ID"),
    controllerRoleId: roleId,
    autoJoinChannelId: str(env, "AUTO_JOIN_CHANNEL_ID"),
    idleLeaveMs: integer(env, "IDLE_LEAVE_SECONDS", 300, 10, 86_400, problems) * 1000,
    maxConcurrentSpeakers: integer(env, "MAX_CONCURRENT_SPEAKERS", 8, 1, 50, problems),
    editIntervalMs: integer(env, "EDIT_INTERVAL_MS", 1_100, 300, 10_000, problems),
    editJitterMs: integer(env, "EDIT_JITTER_MS", 250, 0, 5_000, problems),
    stt: {
      backend,
      url: sttUrl,
      apiKey,
      model: str(env, "STT_MODEL") ?? (backend === "realtime" ? DEFAULT_REALTIME_MODEL : undefined),
      language,
      chunkSeconds: decimal(env, "STT_CHUNK_SECONDS", 4, 1, 30, problems),
      timeoutMs: integer(env, "STT_TIMEOUT_SECONDS", 20, 2, 300, problems) * 1000,
      streamingDelayMs: streamingDelay(env, problems),
      maxSessionSeconds: integer(env, "STT_MAX_SESSION_SECONDS", 240, 30, 3_600, problems),
    },
    vad: {
      rmsThreshold: decimal(env, "VAD_RMS_THRESHOLD", 0.012, 0.0005, 0.5, problems),
      speechFramesToStart: integer(env, "VAD_SPEECH_FRAMES", 2, 1, 50, problems),
      hangoverMs: integer(env, "VAD_HANGOVER_MS", 700, 150, 5_000, problems),
      preRollMs: integer(env, "VAD_PREROLL_MS", 400, 0, 2_000, problems),
      maxUtteranceMs: integer(env, "VAD_MAX_UTTERANCE_SECONDS", 60, 5, 600, problems) * 1000,
      minUtteranceMs: integer(env, "VAD_MIN_UTTERANCE_MS", 300, 0, 5_000, problems),
    },
    logLevel: (isLogLevel(logLevelRaw) ? logLevelRaw : "info") as LogLevel,
  };

  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}
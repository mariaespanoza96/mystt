/**
 * Small structured JSON logger. One line per record, so `jq`/`docker logs`
 * stay usable without pulling in a logging framework.
 */

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(fields: Record<string, unknown>, message: string): void;
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
  child(base: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  level: LogLevel;
  /** Defaults to stdout.write; injectable for tests. */
  sink?: (line: string) => void;
  now?: () => Date;
}

const REDACT_KEYS = new Set(["token", "apiKey", "authorization"]);

function serialiseError(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

function serialiseFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = REDACT_KEYS.has(key) && typeof value === "string" ? `${value.slice(0, 6)}…` : serialiseError(value);
  }
  return out;
}

export function createLogger(options: LoggerOptions): Logger {
  const threshold = RANK[options.level];
  const sink = options.sink ?? ((line: string) => process.stdout.write(`${line}\n`));
  const now = options.now ?? (() => new Date());

  const make = (base: Record<string, unknown>): Logger => {
    const emit = (level: LogLevel, fields: Record<string, unknown>, message: string) => {
      if (RANK[level] < threshold) return;
      sink(
        JSON.stringify({
          time: now().toISOString(),
          level,
          msg: message,
          ...serialiseFields(base),
          ...serialiseFields(fields),
        }),
      );
    };
    return {
      debug: (fields, message) => emit("debug", fields, message),
      info: (fields, message) => emit("info", fields, message),
      warn: (fields, message) => emit("warn", fields, message),
      error: (fields, message) => emit("error", fields, message),
      child: (extra) => make({ ...base, ...extra }),
    };
  };

  return make({});
}

export function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}
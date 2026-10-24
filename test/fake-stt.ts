import { WebSocketServer, type WebSocket } from "ws";
import type { AddressInfo } from "node:net";

/**
 * Protocol-accurate fake of the Mistral realtime transcription socket.
 * Every session is recorded so tests can assert on what the bot sent.
 */

export interface FakeSession {
  url: string;
  authorization: string | undefined;
  updates: Record<string, unknown>[];
  appends: number;
  audioBytes: number;
  flushes: number;
  ended: boolean;
  closed: boolean;
  /** Sends a delta to the client. */
  delta(text: string): void;
  /** Sends the final transcript then closes. */
  finish(text: string): void;
  fail(message: string): void;
}

export interface FakeSttServer {
  url: string;
  sessions: FakeSession[];
  close(): Promise<void>;
}

export interface FakeSttOptions {
  /** Text the server emits for the Nth audio append (1-based). */
  deltaForAppend?: (index: number) => string | undefined;
  /** Reject the handshake entirely. */
  rejectHandshake?: boolean;
  /** Reply with an error event instead of session.updated. */
  rejectUpdate?: string;
}

export async function startFakeStt(options: FakeSttOptions = {}): Promise<FakeSttServer> {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  const sessions: FakeSession[] = [];
  const sockets = new Set<WebSocket>();

  server.on("connection", (socket, request) => {
    sockets.add(socket);
    if (options.rejectHandshake) {
      socket.close(1008, "rejected");
      return;
    }
    const session: FakeSession = {
      url: request.url ?? "",
      authorization: request.headers.authorization,
      updates: [],
      appends: 0,
      audioBytes: 0,
      flushes: 0,
      ended: false,
      closed: false,
      delta(text) {
        socket.send(JSON.stringify({ type: "transcription.text.delta", text }));
      },
      finish(text) {
        socket.send(JSON.stringify({ type: "transcription.done", text, segments: [], usage: {} }));
        socket.close(1000);
      },
      fail(message) {
        socket.send(JSON.stringify({ type: "error", error: { message, code: 3051 } }));
      },
    };
    sessions.push(session);
    socket.send(
      JSON.stringify({
        type: "session.created",
        session: { audio_format: { encoding: "pcm_s16le", sample_rate: 16000 }, diarize: false },
      }),
    );

    socket.on("message", (raw) => {
      const event = JSON.parse(raw.toString()) as { type: string; session?: Record<string, unknown>; audio?: string };
      if (event.type === "session.update") {
        if (options.rejectUpdate) {
          session.fail(options.rejectUpdate);
          return;
        }
        session.updates.push(event.session ?? {});
        socket.send(JSON.stringify({ type: "session.updated", session: event.session ?? {} }));
        return;
      }
      if (event.type === "input_audio.append") {
        session.appends += 1;
        session.audioBytes += Buffer.from(event.audio ?? "", "base64").length;
        const delta = options.deltaForAppend?.(session.appends);
        if (delta) socket.send(JSON.stringify({ type: "transcription.text.delta", text: delta }));
        return;
      }
      if (event.type === "input_audio.flush") {
        session.flushes += 1;
        return;
      }
      if (event.type === "input_audio.end") {
        session.ended = true;
        session.finish("final text");
      }
    });
    socket.on("close", () => {
      session.closed = true;
      sockets.delete(socket);
    });
  });

  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as AddressInfo;

  return {
    url: `ws://127.0.0.1:${address.port}/v1/audio/transcriptions/realtime`,
    sessions,
    async close() {
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

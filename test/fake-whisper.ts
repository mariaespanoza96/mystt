import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Fake OpenAI-compatible `/v1/audio/transcriptions` endpoint, shaped like the
 * whisper.cpp server. Every request is recorded so tests can assert on it.
 */

export interface FakeRequest {
  authorization: string | undefined;
  fields: Record<string, string>;
  /** PCM bytes inside the uploaded WAV (header stripped). */
  audioBytes: number;
}

export interface FakeWhisperOptions {
  /** Text for the Nth request (1-based); undefined answers with an empty transcript. */
  reply?: (index: number, request: FakeRequest) => string | undefined;
  /** HTTP status for the Nth request; defaults to 200. */
  status?: (index: number) => number;
  /** Delay before answering the Nth request. */
  delayMs?: (index: number) => number;
}

export interface FakeWhisperServer {
  url: string;
  requests: FakeRequest[];
  close(): Promise<void>;
}

export async function startFakeWhisper(options: FakeWhisperOptions = {}): Promise<FakeWhisperServer> {
  const requests: FakeRequest[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      const request = await parseMultipart(req);
      requests.push(request);
      const index = requests.length;
      const delay = options.delayMs?.(index) ?? 0;
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      const status = options.status?.(index) ?? 200;
      res.writeHead(status, { "content-type": "application/json" });
      if (status !== 200) {
        res.end(JSON.stringify({ error: "failed" }));
        return;
      }
      res.end(JSON.stringify({ text: options.reply?.(index, request) ?? "" }));
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/v1/audio/transcriptions`,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function parseMultipart(req: IncomingMessage): Promise<FakeRequest> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks);
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(req.headers["content-type"] ?? "");
  const marker = Buffer.from(`--${boundary?.[1] ?? boundary?.[2] ?? ""}`);
  const fields: Record<string, string> = {};
  let audioBytes = 0;
  let start = body.indexOf(marker);
  while (start !== -1) {
    const next = body.indexOf(marker, start + marker.length);
    if (next === -1) break;
    const part = body.subarray(start + marker.length + 2, next - 2);
    const split = part.indexOf("\r\n\r\n");
    const headers = part.subarray(0, split).toString();
    const content = part.subarray(split + 4);
    const name = /name="([^"]+)"/.exec(headers)?.[1] ?? "";
    if (name === "file") audioBytes = content.length - 44;
    else fields[name] = content.toString();
    start = next;
  }
  return { authorization: req.headers.authorization, fields, audioBytes };
}

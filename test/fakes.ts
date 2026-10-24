import { randomUUID } from "node:crypto";
import type { APIEmbed, Message } from "discord.js";
import type { SendableChannel } from "../src/discord-types.js";

/** Minimal stand-ins for the parts of discord.js the transcript writer touches. */

export interface FakeMessage extends Omit<Message, "embeds"> {
  content: string;
  embeds: APIEmbed[];
  edits: number;
  deleted: boolean;
  /** What a reader sees: plain content, or a speaker embed as "author\ndescription". */
  readonly text: string;
}

interface FakeBody {
  content?: string;
  embeds?: APIEmbed[];
}

export function createFakeMessage(body: FakeBody = {}): FakeMessage {
  const message = {
    id: randomUUID().replace(/\D/g, "").padEnd(18, "7").slice(0, 18),
    content: body.content ?? "",
    embeds: body.embeds ?? [],
    edits: 0,
    deleted: false,
    get text(): string {
      const embed = message.embeds[0];
      return embed ? `${embed.author?.name ?? ""}\n${embed.description ?? ""}` : message.content;
    },
    async edit(options: FakeBody) {
      if (options.content !== undefined) message.content = options.content;
      if (options.embeds !== undefined) message.embeds = options.embeds;
      message.edits += 1;
      return message;
    },
    async delete() {
      message.deleted = true;
      return message;
    },
  };
  return message as unknown as FakeMessage;
}

export class FakeChannel implements SendableChannel {
  public readonly id = "chan-1";
  public readonly sent: FakeMessage[] = [];

  public async send(options: FakeBody): Promise<Message> {
    const message = createFakeMessage(options);
    this.sent.push(message);
    return message as unknown as Message;
  }

  public get transcriptLines(): string[] {
    return this.sent.filter((message) => !message.deleted).map((message) => message.text);
  }
}
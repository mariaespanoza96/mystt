import type { APIEmbed, Message } from "discord.js";

/** The slice of a voice/text channel the writer needs. Voice channels implement it. */
export interface SendableChannel {
  id: string;
  send(options: { content?: string; embeds?: APIEmbed[]; allowedMentions: { parse: [] } }): Promise<Message>;
}
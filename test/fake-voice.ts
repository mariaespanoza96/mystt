import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mock } from "node:test";

/**
 * Minimal `@discordjs/voice` stand-in: the join handshake stays pending until a
 * test resolves it, exactly like a real connection waiting for the gateway.
 */

export class FakeConnection extends EventEmitter {
  public state: { status: string } = { status: "signalling" };
  public lastStream: PassThrough | undefined;

  public readonly receiver = {
    speaking: Object.assign(new EventEmitter(), { users: new Set<string>() }),
    subscribe: (userId: string) => {
      const stream = new PassThrough();
      this.lastStream = stream;
      this.subscribed.push(userId);
      return stream;
    },
  };

  public readonly subscribed: string[] = [];

  public destroy(): void {
    if (this.state.status === "destroyed") {
      throw new Error("Cannot destroy VoiceConnection - it has already been destroyed");
    }
    this.state = { status: "destroyed" };
  }

  /** Emulates the library announcing that a member started talking. */
  public startSpeaking(userId: string): void {
    this.receiver.speaking.users.add(userId);
    this.receiver.speaking.emit("start", userId);
  }

  public speakingListenerCount(): number {
    return this.receiver.speaking.listenerCount("start");
  }
}

export const connections: FakeConnection[] = [];
export const handshakes: { resolve: () => void; reject: (error?: Error) => void }[] = [];

export function installVoiceMock(): void {
  mock.module("@discordjs/voice", {
    exports: {
      joinVoiceChannel: () => {
        const connection = new FakeConnection();
        connections.push(connection);
        return connection;
      },
      entersState: () =>
        new Promise<void>((resolve, reject) => {
          handshakes.push({ resolve, reject });
        }),
      getVoiceConnection: () => undefined,
      VoiceConnectionStatus: {
        Signalling: "signalling",
        Connecting: "connecting",
        Ready: "ready",
        Disconnected: "disconnected",
        Destroyed: "destroyed",
      },
      EndBehaviorType: { Manual: 0, AfterSilence: 1, AfterDuration: 2 },
    },
  });
}

/** Connection created by the most recent start() call. */
export const latestConnection = () => connections[connections.length - 1]!;

/** Most recent handshake; each start() registers exactly one. */
export const latestHandshake = () => handshakes[handshakes.length - 1]!;

export const tick = (ms = 5): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
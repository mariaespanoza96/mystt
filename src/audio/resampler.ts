/**
 * Discord delivers 48 kHz stereo signed-16-bit PCM. The transcription model
 * wants 16 kHz mono. Resampling is stateful so a chunk boundary in the middle
 * of a 3-sample group cannot click.
 */

export const DISCORD_SAMPLE_RATE = 48_000;
export const DISCORD_CHANNELS = 2;
export const MODEL_SAMPLE_RATE = 16_000;
const DECIMATION = DISCORD_SAMPLE_RATE / MODEL_SAMPLE_RATE;

export class Stereo48kToMono16k {
  private carry: number[] = [];

  /** Converts one interleaved stereo frame; returns the 16 kHz mono samples completed by it. */
  public push(stereoPcm: Buffer): Buffer {
    const frames = Math.floor(stereoPcm.length / (2 * DISCORD_CHANNELS));
    if (frames === 0) return Buffer.alloc(0);

    for (let frame = 0; frame < frames; frame += 1) {
      const offset = frame * 4;
      const left = stereoPcm.readInt16LE(offset);
      const right = stereoPcm.readInt16LE(offset + 2);
      this.carry.push((left + right) / 2);
    }

    return this.drain(false);
  }

  /** Emits the final partial group, zero padded. Call before closing a stream. */
  public flush(): Buffer {
    return this.drain(true);
  }

  public reset(): void {
    this.carry = [];
  }

  public get pendingSamples(): number {
    return this.carry.length;
  }

  private drain(pad: boolean): Buffer {
    const complete = Math.floor(this.carry.length / DECIMATION);
    if (complete === 0) {
      if (!pad || this.carry.length === 0) return Buffer.alloc(0);
      const tail = this.carry.reduce((sum, sample) => sum + sample, 0) / this.carry.length;
      this.carry = [];
      const single = Buffer.allocUnsafe(2);
      single.writeInt16LE(clamp16(Math.round(tail)), 0);
      return single;
    }

    const output = Buffer.allocUnsafe(complete * 2);
    for (let group = 0; group < complete; group += 1) {
      // Box filter over the decimation window: cheap anti-aliasing before the 3:1 drop.
      const sum = this.carry[group * DECIMATION]! + this.carry[group * DECIMATION + 1]! + this.carry[group * DECIMATION + 2]!;
      output.writeInt16LE(clamp16(Math.round(sum / DECIMATION)), group * 2);
    }
    this.carry = this.carry.slice(complete * DECIMATION);
    if (pad && this.carry.length > 0) {
      const tail = this.carry.reduce((sum, sample) => sum + sample, 0) / this.carry.length;
      this.carry = [];
      const padded = Buffer.allocUnsafe(output.length + 2);
      output.copy(padded);
      padded.writeInt16LE(clamp16(Math.round(tail)), output.length);
      return padded;
    }
    return output;
  }
}

/** Root-mean-square of a 16-bit mono buffer, normalised to 0..1. */
export function rms(pcm16Mono: Buffer): number {
  const samples = Math.floor(pcm16Mono.length / 2);
  if (samples === 0) return 0;
  let total = 0;
  for (let index = 0; index < samples; index += 1) {
    const value = pcm16Mono.readInt16LE(index * 2) / 32_768;
    total += value * value;
  }
  return Math.sqrt(total / samples);
}

function clamp16(value: number): number {
  if (value > 32_767) return 32_767;
  if (value < -32_768) return -32_768;
  return value;
}

/** Regroups arbitrary audio writes into fixed-size frames so the socket carries predictable chunks. */
export class PcmFrameChunker {
  private residual: Buffer = Buffer.alloc(0);

  public constructor(private readonly frameBytes: number) {
    if (!Number.isSafeInteger(frameBytes) || frameBytes < 2) throw new Error("frameBytes must be a positive even integer");
  }

  public push(pcm: Buffer): Buffer[] {
    if (pcm.length === 0) return [];
    const joined = this.residual.length === 0 ? pcm : Buffer.concat([this.residual, pcm]);
    const frames: Buffer[] = [];
    let offset = 0;
    while (joined.length - offset >= this.frameBytes) {
      frames.push(joined.subarray(offset, offset + this.frameBytes));
      offset += this.frameBytes;
    }
    this.residual = offset === joined.length ? Buffer.alloc(0) : Buffer.from(joined.subarray(offset));
    return frames;
  }

  public flush(): Buffer | undefined {
    if (this.residual.length === 0) return undefined;
    const frame = this.residual;
    this.residual = Buffer.alloc(0);
    return frame;
  }
}

/** 100 ms of 16 kHz mono s16le. */
export const MODEL_FRAME_BYTES = (MODEL_SAMPLE_RATE / 10) * 2;
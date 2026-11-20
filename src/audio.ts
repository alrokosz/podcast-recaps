import { execFile } from "node:child_process";
import { closeSync, openSync, readFileSync, writeSync } from "node:fs";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Mono 16-bit PCM at 44.1 kHz: every clip is converted to this before joining. */
const PCM_FORMAT = "LEI16@44100";

export interface Wav {
  /** Raw "fmt " chunk body. */
  format: Buffer;
  data: Buffer;
}

export const readWav = (path: string): Wav => parseWav(readFileSync(path));

export const parseWav = (wav: Buffer): Wav => {
  if (wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Not a WAV file.");
  }
  let format: Buffer | undefined;
  for (let offset = 12; offset + 8 <= wav.length; ) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const body = wav.subarray(offset + 8, offset + 8 + size);
    if (id === "fmt ") format = body;
    if (id === "data") {
      if (!format) throw new Error("WAV data appears before its format chunk.");
      return { format, data: body };
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error("WAV file has no audio data.");
};

const describe = (format: Buffer) => ({
  channels: format.readUInt16LE(2),
  sampleRate: format.readUInt32LE(4),
  blockAlign: format.readUInt16LE(12),
});

export const silence = (format: Buffer, milliseconds: number): Buffer => {
  const { sampleRate, blockAlign } = describe(format);
  return Buffer.alloc(Math.round((sampleRate * milliseconds) / 1000) * blockAlign);
};

/** Writes one WAV from clips that share the same format. */
export const writeJoinedWav = (path: string, format: Buffer, clips: Buffer[]): void => {
  const dataSize = clips.reduce((total, clip) => total + clip.length, 0);
  const header = Buffer.alloc(20 + format.length + 8);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(header.length - 8 + dataSize, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(format.length, 16);
  format.copy(header, 20);
  header.write("data", 20 + format.length, "ascii");
  header.writeUInt32LE(dataSize, 24 + format.length);

  const fd = openSync(path, "w");
  try {
    writeSync(fd, header);
    for (const clip of clips) writeSync(fd, clip);
  } finally {
    closeSync(fd);
  }
};

/** Converts any audio file macOS can decode (MP3, AIFF, M4A) to the shared PCM format. */
export const toPcmWav = async (input: string, output: string): Promise<void> => {
  await run("afconvert", [input, "-o", output, "-f", "WAVE", "-d", PCM_FORMAT, "-c", "1"]);
};

export const encodeAac = async (input: string, output: string, bitsPerSecond = 96_000): Promise<void> => {
  await run("afconvert", [input, "-o", output, "-f", "m4af", "-d", "aac", "-b", String(bitsPerSecond)]);
};

/** Narrates a text file with a macOS voice. `wordsPerMinute` defaults to the voice's own rate. */
export const speak = async (
  scriptPath: string,
  output: string,
  { voice, wordsPerMinute }: { voice?: string; wordsPerMinute?: number } = {},
): Promise<void> => {
  const options = [...(voice ? ["-v", voice] : []), ...(wordsPerMinute ? ["-r", String(wordsPerMinute)] : [])];
  await run("say", [...options, "-f", scriptPath, "-o", output], { timeout: 180_000 });
};

export const durationSeconds = async (path: string): Promise<number> => {
  const { stdout } = await run("afinfo", [path]);
  const seconds = Number(/estimated duration:\s*([\d.]+)/.exec(stdout)?.[1]);
  if (!Number.isFinite(seconds)) throw new Error(`Could not read the duration of ${path}.`);
  return seconds;
};

/** Root-mean-square level of 16-bit PCM, from 0 to 1. */
export const rmsLevel = (pcm: Buffer): number => {
  const samples = Math.floor(pcm.length / 2);
  if (!samples) return 0;
  let total = 0;
  for (let i = 0; i < samples; i++) {
    const value = pcm.readInt16LE(i * 2) / 32_768;
    total += value * value;
  }
  return Math.sqrt(total / samples);
};

/** Samples below this fraction of full scale pass through unchanged. */
const LIMITER_THRESHOLD = 0.7;

/** Leaves quiet samples alone and smoothly compresses louder ones so output stays below full scale. */
const softLimit = (value: number): number => {
  const magnitude = Math.abs(value);
  if (magnitude <= LIMITER_THRESHOLD) return value;
  const headroom = 1 - LIMITER_THRESHOLD;
  return Math.sign(value) * (LIMITER_THRESHOLD + headroom * Math.tanh((magnitude - LIMITER_THRESHOLD) / headroom));
};

/** Scales 16-bit PCM so its RMS level matches `targetLevel`, soft-limiting peaks instead of clipping them. */
export const matchLevel = (pcm: Buffer, targetLevel: number): Buffer => {
  const current = rmsLevel(pcm);
  if (!current || !targetLevel) return pcm;
  const gain = targetLevel / current;
  const output = Buffer.alloc(pcm.length);
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const value = softLimit((pcm.readInt16LE(i) / 32_768) * gain);
    output.writeInt16LE(Math.max(-32_768, Math.min(32_767, Math.round(value * 32_768))), i);
  }
  return output;
};

export const sameFormat = (a: Buffer, b: Buffer): boolean => {
  const x = describe(a);
  const y = describe(b);
  return x.channels === y.channels && x.sampleRate === y.sampleRate && x.blockAlign === y.blockAlign;
};

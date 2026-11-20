import { execFile } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { promisify } from "node:util";

const run = promisify(execFile);

const projectRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");
const whisperCli = process.env.WHISPER_CLI ?? join(projectRoot, ".tools/whisper.cpp/build/bin/whisper-cli");
const whisperModel =
  process.env.WHISPER_MODEL ?? join(projectRoot, ".tools/whisper.cpp/models/ggml-small.en-q5_1.bin");

/** Downloads to a temporary file first, so an interrupted download is never reused. */
export const downloadFile = async (url: string, destination: string): Promise<void> => {
  if (existsSync(destination)) return;
  mkdirSync(dirname(destination), { recursive: true });
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}) for ${url}`);
  const partial = `${destination}.partial`;
  try {
    // fetch() returns the DOM stream type, which Node's stream helpers accept at runtime.
    await pipeline(Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>), createWriteStream(partial));
    renameSync(partial, destination);
  } finally {
    rmSync(partial, { force: true });
  }
};

/** Transcribes audio with local whisper.cpp and caches the plain-text result. */
export const transcribe = async (audioPath: string, transcriptPath: string): Promise<string> => {
  if (existsSync(transcriptPath)) return readFileSync(transcriptPath, "utf8");
  for (const [name, path] of [
    ["whisper-cli", whisperCli],
    ["Whisper model", whisperModel],
  ] as const) {
    if (!existsSync(path)) throw new Error(`${name} not found at ${path}. See the README for transcription setup.`);
  }

  mkdirSync(dirname(transcriptPath), { recursive: true });
  const outputBase = transcriptPath.replace(/\.txt$/, "");
  await run(whisperCli, ["-m", whisperModel, "-f", audioPath, "-t", "8", "-np", "-otxt", "-of", outputBase], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return readFileSync(transcriptPath, "utf8");
};

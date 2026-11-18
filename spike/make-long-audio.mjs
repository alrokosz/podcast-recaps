// Builds hour-long episodes 4-6 by looping the PCM audio of short episodes 1-3.
import { execFileSync } from "node:child_process";
import { closeSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const audioDir = join(here, "data", "audio");
const manifestPath = join(here, "data", "episodes.json");
const targetSeconds = 3600;

const readWav = (path) => {
  const wav = readFileSync(path);
  let fmt;
  for (let offset = 12; offset + 8 <= wav.length; ) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (id === "fmt ") fmt = wav.subarray(offset + 8, offset + 8 + size);
    if (id === "data") return { fmt, pcm: wav.subarray(offset + 8, offset + 8 + size) };
    offset += 8 + size + (size % 2);
  }
  throw new Error(`No PCM data in ${path}`);
};

const writeLoopedWav = (path, fmt, pcm, loops) => {
  const dataSize = pcm.length * loops;
  const header = Buffer.alloc(12 + 8 + fmt.length + 8);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(header.length - 8 + dataSize, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(fmt.length, 16);
  fmt.copy(header, 20);
  header.write("data", 20 + fmt.length, "ascii");
  header.writeUInt32LE(dataSize, 24 + fmt.length);

  const fd = openSync(path, "w");
  try {
    writeSync(fd, header);
    for (let i = 0; i < loops; i++) writeSync(fd, pcm);
  } finally {
    closeSync(fd);
  }
};

const manifest = JSON.parse(readFileSync(manifestPath, "utf8")).filter(({ number }) => number <= 3);
const longEpisodes = [];

for (const source of manifest) {
  const number = source.number + 3;
  const file = `episode-${number}.m4a`;
  const sourceWav = join(audioDir, `source-${number}.wav`);
  const longWav = join(audioDir, `long-${number}.wav`);
  const output = join(audioDir, file);

  try {
    execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16", join(audioDir, source.file), sourceWav]);
    const { fmt, pcm } = readWav(sourceWav);
    writeLoopedWav(longWav, fmt, pcm, Math.ceil(targetSeconds / source.durationSeconds));
    execFileSync("afconvert", ["-f", "m4af", "-d", "aac", "-b", "64000", longWav, output]);
  } finally {
    rmSync(sourceWav, { force: true });
    rmSync(longWav, { force: true });
  }

  const info = execFileSync("afinfo", [output], { encoding: "utf8" });
  const duration = Number(info.match(/estimated duration:\s*([\d.]+)/)?.[1]);
  if (!Number.isFinite(duration)) throw new Error(`Could not read duration for ${file}`);
  longEpisodes.push({ number, file, bytes: statSync(output).size, durationSeconds: Math.round(duration) });
}

const merged = [...manifest, ...longEpisodes];
writeFileSync(manifestPath, `${JSON.stringify(merged, null, 2)}\n`);
console.log(longEpisodes);

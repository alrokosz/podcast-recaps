// Generates short spoken test episodes with macOS `say` and `afconvert`.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const audioDir = join(here, "data", "audio");
mkdirSync(audioDir, { recursive: true });

// Usage: node generate-audio.mjs [firstEpisode] [episodeCount] [markersPerEpisode]
const firstEpisode = Number(process.argv[2] ?? 1);
const episodeCount = Number(process.argv[3] ?? 3);
const markerCount = Number(process.argv[4] ?? 60);
const manifestPath = join(here, "data", "episodes.json");

const episodes = [];
for (let number = firstEpisode; number < firstEpisode + episodeCount; number++) {
  const markers = Array.from({ length: markerCount }, (_, i) => `Episode ${number}, marker ${i + 1}.`);
  const script = `This is spike test episode ${number}. ${markers.join(" [[slnc 400]] ")}`;
  const aiff = join(audioDir, `episode-${number}.aiff`);
  const file = `episode-${number}.m4a`;
  const output = join(audioDir, file);

  execFileSync("say", ["-o", aiff, script]);
  execFileSync("afconvert", ["-f", "m4af", "-d", "aac", "-b", "64000", aiff, output]);
  rmSync(aiff);

  const info = execFileSync("afinfo", [output], { encoding: "utf8" });
  const duration = Number(info.match(/estimated duration:\s*([\d.]+)/)?.[1]);
  if (!Number.isFinite(duration)) throw new Error(`Could not read duration for ${file}`);

  episodes.push({ number, file, bytes: statSync(output).size, durationSeconds: Math.round(duration) });
}

const existing = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : [];
const generated = new Set(episodes.map(({ number }) => number));
const merged = [...existing.filter(({ number }) => !generated.has(number)), ...episodes].sort(
  (a, b) => a.number - b.number,
);
writeFileSync(manifestPath, `${JSON.stringify(merged, null, 2)}\n`);
console.log(episodes);

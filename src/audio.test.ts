import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { matchLevel, parseWav, rmsLevel, sameFormat, silence, writeJoinedWav } from "./audio.js";

// Mono, 44.1 kHz, 16-bit PCM.
const format = Buffer.alloc(16);
format.writeUInt16LE(1, 0);
format.writeUInt16LE(1, 2);
format.writeUInt32LE(44_100, 4);
format.writeUInt32LE(88_200, 8);
format.writeUInt16LE(2, 12);
format.writeUInt16LE(16, 14);

test("silence matches the sample rate and block size", () => {
  assert.equal(silence(format, 1000).length, 88_200);
  assert.equal(silence(format, 10).length, 882);
});

test("joined WAV round-trips with clips in order", () => {
  const dir = mkdtempSync(join(tmpdir(), "recaps-audio-"));
  try {
    const path = join(dir, "joined.wav");
    writeJoinedWav(path, format, [Buffer.from([1, 2]), Buffer.from([3, 4, 5, 6])]);
    const wav = parseWav(readFileSync(path));
    assert.deepEqual([...wav.data], [1, 2, 3, 4, 5, 6]);
    assert.ok(sameFormat(wav.format, format));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const pcm = (...samples: number[]) => {
  const buffer = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, i) => buffer.writeInt16LE(sample, i * 2));
  return buffer;
};

test("matchLevel raises quiet audio to the target level", () => {
  const quiet = pcm(1000, -1000, 1000, -1000);
  const louder = matchLevel(quiet, rmsLevel(pcm(4000, -4000, 4000, -4000)));
  assert.equal(louder.readInt16LE(0), 4000);
  assert.ok(Math.abs(rmsLevel(louder) - 4000 / 32_768) < 1e-6);
});

test("matchLevel soft-limits peaks instead of clipping them", () => {
  const boosted = matchLevel(pcm(20_000, 1000, 0, -20_000), 0.9);
  const peak = boosted.readInt16LE(0);
  assert.ok(peak > 0.7 * 32_768 && peak < 32_767, `peak ${peak} should be limited below full scale`);
  assert.equal(boosted.readInt16LE(6), -peak);
  assert.ok(boosted.readInt16LE(2) < peak, "quieter samples stay quieter than peaks");
});

test("rejects non-WAV input", () => {
  assert.throws(() => parseWav(Buffer.from("not audio at all")), /Not a WAV file/);
});

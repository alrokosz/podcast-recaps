import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import type { z } from "zod";
import type { Episode, Show } from "./feed.js";
import { DEFAULT_SETTINGS, prepareRecap, type RecapSettings } from "./pipeline.js";
import type { GenerateRequest, RecapWriter, ResearchRequest, ResearchResult } from "./writer.js";

/** A writer that answers each step from a script and records every request it sees. */
class ScriptedWriter implements RecapWriter {
  readonly name = "scripted";
  readonly requests: { step: string; prompt: string }[] = [];
  checkVerdicts: ("pass" | "fail")[] = [];
  references: { name: string; mentionedIn: string[] }[] = [];

  async generate<Schema extends z.ZodType>({ step, prompt, schema }: GenerateRequest<Schema>): Promise<z.infer<Schema>> {
    this.requests.push({ step, prompt });
    const [kind = "", label = ""] = step.split(" ");
    const outputs: Record<string, unknown> = {
      summarize: {
        summary: `SUMMARY-${label}`,
        keyEvents: [`event in ${label}`],
        people: [{ name: "Charles", role: "king" }],
        openThreads: [`thread from ${label}`],
      },
      brief: {
        threads: [{ earlierFact: "The king left London.", sourceEpisodes: ["1.2"] }],
        spoilerTopics: ["the battle"],
        explainedInEpisode: [],
        outsideReferences: this.references,
      },
      background: {
        facts: [1, 2, 3].map((n) => ({ fact: `Fact ${n}.`, sourceIds: [n] })),
      },
      script: { narration: `Narration ${this.requests.filter((r) => r.step.startsWith("script")).length}.` },
      check: kind === "check" && {
        verdict: this.checkVerdicts.shift() ?? "pass",
        issues: [{ excerpt: "the battle", problem: "spoiler", explanation: "Revealed next." }],
      },
    };
    const output = outputs[kind];
    assert.ok(output, `unexpected step ${step}`);
    // Validate like the real writers do, so the test fails if a schema and this script drift apart.
    return schema.parse(output);
  }

  async research({ step, prompt }: ResearchRequest): Promise<ResearchResult> {
    this.requests.push({ step, prompt });
    return {
      notes: "Notes [1] [2] [3]",
      sources: [1, 2, 3].map((id) => ({ id, title: `Source ${id}`, url: `https://example.com/${id}`, excerpts: ["text"] })),
    };
  }
}

const labels = ["1.1", "1.2", "1.3", "1.4"];
const show: Show = {
  title: "Test Show",
  slug: "test-show",
  episodes: labels.map(
    (label, index): Episode => ({
      index,
      guid: `guid-${label}`,
      title: `${label}- Episode ${label}`,
      label,
      publishedAt: new Date(2024, 0, index + 1),
      audioUrl: `https://example.com/${label}.mp3`,
    }),
  ),
};
// Preparing 1.3: 1.1 and 1.2 are earlier, 1.4 is in the future.
const target = show.episodes[2] as Episode;

let workDir = "";
const setUp = () => {
  workDir = mkdtempSync(join(tmpdir(), "recaps-pipeline-"));
  for (const dir of ["audio", "transcripts"]) mkdirSync(join(workDir, dir));
  for (const label of labels) {
    // Cached audio and transcripts, so nothing is downloaded or transcribed.
    writeFileSync(join(workDir, "audio", `${label}.mp3`), "");
    writeFileSync(join(workDir, "transcripts", `${label}.txt`), `TRANSCRIPT-${label}`);
  }
};
afterEach(() => rmSync(workDir, { recursive: true, force: true }));

const prepare = (writer: ScriptedWriter, settings: Partial<RecapSettings> = {}) =>
  prepareRecap({ writer, show, target, workDir, settings: { ...DEFAULT_SETTINGS, ...settings }, scriptOnly: true });

const promptsFor = (writer: ScriptedWriter, kind: string) =>
  writer.requests.filter(({ step }) => step.startsWith(kind)).map(({ prompt }) => prompt);

const nth = (prompts: string[], index: number): string => {
  const prompt = prompts[index];
  assert.ok(prompt !== undefined, `expected at least ${index + 1} prompts`);
  return prompt;
};

test("the writer never sees future episodes, and only private steps see the upcoming one", async () => {
  setUp();
  const writer = new ScriptedWriter();
  const result = await prepare(writer);

  assert.deepEqual(
    writer.requests.map(({ step }) => step),
    ["summarize 1.1", "summarize 1.2", "brief 1.3", "script 1.3", "check 1.3"],
  );
  for (const { prompt } of writer.requests) {
    assert.doesNotMatch(prompt, /1\.4/, "nothing from a future episode");
  }
  for (const prompt of promptsFor(writer, "script")) {
    assert.doesNotMatch(prompt, /TRANSCRIPT-1\.3/, "the narration is written without the upcoming transcript");
  }
  for (const prompt of [...promptsFor(writer, "brief"), ...promptsFor(writer, "check")]) {
    assert.match(prompt, /TRANSCRIPT-1\.3/, "planning and checking read the upcoming episode privately");
  }
  assert.match(result.spoken, /Narration 1\./);
  assert.match(result.spoken, /^This is an unofficial, AI-generated recap\./);

  const saved = JSON.parse(readFileSync(result.textPath.replace(/\.txt$/, ".json"), "utf8"));
  assert.equal(saved.model, "scripted");
  const summary = JSON.parse(readFileSync(join(workDir, "summaries", "1.1.json"), "utf8"));
  assert.equal(summary.model, "scripted");
});

test("a failed check is rewritten with the issues, then saved summaries and recaps are reused", async () => {
  setUp();
  const writer = new ScriptedWriter();
  writer.checkVerdicts = ["fail", "pass"];
  const result = await prepare(writer);

  const scripts = promptsFor(writer, "script");
  assert.equal(scripts.length, 2);
  assert.match(nth(scripts, 1), /spoiler: "the battle"/);
  assert.match(result.spoken, /Narration 2\./);

  const again = new ScriptedWriter();
  const reused = await prepare(again);
  assert.equal(reused.reused, true);
  assert.deepEqual(again.requests, [], "nothing is written twice");
});

test("Further Context researches only references from earlier episodes", async () => {
  setUp();
  const writer = new ScriptedWriter();
  writer.references = [
    { name: "Grand Remonstrance", mentionedIn: ["1.1"] },
    { name: "Irish rising", mentionedIn: ["1.2"] },
    { name: "Edgehill", mentionedIn: ["1.3"] },
  ];
  const result = await prepare(writer, { mode: "further-context" });

  const research = nth(promptsFor(writer, "research"), 0);
  assert.match(research, /Grand Remonstrance/);
  assert.doesNotMatch(research, /Edgehill/, "a reference first named in the upcoming episode is never researched");
  assert.doesNotMatch(research, /TRANSCRIPT-1\.3/);
  assert.match(nth(promptsFor(writer, "script"), 0), /Fact 1\./);
  assert.equal(result.spokenMode, "further-context");
  assert.match(readFileSync(result.sourcesPath ?? "", "utf8"), /https:\/\/example\.com\/1/);
});

test("Further Context falls back to a Recap when there is little to research", async () => {
  setUp();
  const writer = new ScriptedWriter();
  writer.references = [{ name: "Grand Remonstrance", mentionedIn: ["1.1"] }];
  const result = await prepare(writer, { mode: "further-context" });

  assert.deepEqual(promptsFor(writer, "research"), []);
  assert.equal(result.spokenMode, "recap");
});

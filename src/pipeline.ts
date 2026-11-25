import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  durationSeconds,
  encodeAac,
  matchLevel,
  readWav,
  rmsLevel,
  sameFormat,
  silence,
  speak,
  toPcmWav,
  writeJoinedWav,
} from "./audio.js";
import { contextEpisodes, type Episode, episodeName, parseFeed, type Show } from "./feed.js";
import type { Effort } from "./llm.js";
import { isMode, MODES, type Mode, type Tone, usesResearch } from "./modes.js";
import {
  checkScript,
  type ContextFact,
  createBrief,
  earlierReferences,
  type EpisodeSummary,
  EpisodeSummarySchema,
  type LabeledSummary,
  researchContext,
  SUMMARY_VERSION,
  summarizeEpisode,
  writeScript,
} from "./recap.js";
import { downloadFile, transcribe } from "./transcribe.js";
import type { RecapWriter } from "./writer.js";

/** Everything a listener can choose about a recap. */
export interface RecapSettings {
  mode: Mode;
  tone: Tone | null;
  instructions: string | null;
  model: string;
  effort: Effort;
  voice: string | null;
  wordsPerMinute: number | null;
  pauseSeconds: number;
}

export const DEFAULT_SETTINGS: RecapSettings = {
  mode: "previously-on",
  tone: null,
  instructions: null,
  model: "claude-opus-5-5",
  effort: "low",
  voice: null,
  wordsPerMinute: null,
  pauseSeconds: 1.2,
};

/** A research mode needs at least this many real-world references, and cited facts, to be worth a briefing. */
const MIN_OUTSIDE_REFERENCES = 2;
const MIN_OUTSIDE_FACTS = 3;

export type Log = (message: string) => void;

/** Shows' cached audio, transcripts, summaries, and outputs live in <dataDir>/shows/<slug>. */
export const showDir = (dataDir: string, slug: string): string => join(dataDir, "shows", slug);

export const fetchShow = async (feedUrl: string): Promise<{ show: Show; xml: string }> => {
  const response = await fetch(feedUrl, { redirect: "follow" });
  if (!response.ok) throw new Error(`Could not fetch the feed (${response.status}).`);
  const xml = await response.text();
  return { show: parseFeed(xml), xml };
};

export interface PrepareRequest {
  /** The API with the user's key, or a Claude Code session through the plugin. */
  writer: RecapWriter;
  show: Show;
  target: Episode;
  workDir: string;
  settings: RecapSettings;
  /** Write a new recap even if a passing one with the same settings is saved. */
  regenerate?: boolean;
  /** Stop after the text, without narrating or splicing. */
  scriptOnly?: boolean;
  log?: Log;
  signal?: AbortSignal;
}

export interface PreparedRecap {
  /** The full text read aloud, including the disclaimer and intro. */
  spoken: string;
  /** The mode actually written, since a research mode can fall back to a plain recap. */
  spokenMode: Mode;
  reused: boolean;
  textPath: string;
  audioPath?: string;
  sourcesPath?: string;
  recapSeconds?: number;
}

/** Output files are named after the episode label and the requested mode. */
export const outputBase = (workDir: string, target: Episode, mode: Mode): string =>
  join(workDir, "output", `${target.label}-${mode}`);

export const prepareRecap = async (request: PrepareRequest): Promise<PreparedRecap> => {
  const { writer, show, target, workDir, settings, signal } = request;
  const log = request.log ?? (() => {});
  const context = contextEpisodes(show, target);
  if (!context.length) throw new Error(`"${target.title}" has no earlier episodes to recap.`);

  const base = outputBase(workDir, target, settings.mode);
  mkdirSync(join(workDir, "output"), { recursive: true });
  const recapJson = `${base}.json`;

  const reused = request.regenerate ? undefined : savedNarration(recapJson, settings, writer.name);
  if (reused) log(`Reusing the saved recap for "${target.title}"`);
  const { narration, spokenMode } =
    reused ?? (await createNarration({ writer, show, workDir, target, context, settings, recapJson, log, signal }));

  const spoken = [
    "This is an unofficial, AI-generated recap.",
    MODES[spokenMode].spokenIntro(show.title),
    narration,
    `And now, ${episodeName(target)}.`,
  ].join("\n\n");
  const textPath = `${base}.txt`;
  writeFileSync(textPath, `${spoken}\n`);
  const sourcesPath = existsSync(`${base}.sources.txt`) ? `${base}.sources.txt` : undefined;

  const result: PreparedRecap = { spoken, spokenMode, reused: Boolean(reused), textPath, sourcesPath };
  if (request.scriptOnly) return result;

  signal?.throwIfAborted();
  await getEpisodeAudio(workDir, target);
  const audio = await renderAudio(workDir, base, target, spoken, settings, log);
  return { ...result, ...audio };
};

/** Settings that change the recap text, so a saved recap is reused only when they all match. */
interface SavedRecap {
  model: string;
  tone: Tone | null;
  instructions: string | null;
  mode: Mode;
  /** The mode actually written, when a research mode fell back to a plain recap. */
  spokenMode?: Mode;
  attempts: { narration: string; check: { verdict: string } }[];
}

interface Narration {
  narration: string;
  spokenMode: Mode;
}

/** Whether a passing recap with these writing settings is saved, so preparing it again is free. */
export const hasSavedRecap = (
  workDir: string,
  target: Episode,
  settings: RecapSettings,
  writerName = settings.model,
): boolean => savedNarration(`${outputBase(workDir, target, settings.mode)}.json`, settings, writerName) !== undefined;

/** Returns a saved narration that passed its check with the same writer and writing settings, if any. */
const savedNarration = (path: string, settings: RecapSettings, writerName: string): Narration | undefined => {
  if (!existsSync(path)) return undefined;
  const saved = JSON.parse(readFileSync(path, "utf8")) as Partial<SavedRecap>;
  const last = saved.attempts?.at(-1);
  const sameSettings =
    saved.model === writerName &&
    (saved.tone ?? null) === settings.tone &&
    (saved.instructions ?? null) === settings.instructions;
  if (!sameSettings || last?.check.verdict !== "pass") return undefined;
  const spokenMode = saved.spokenMode ?? settings.mode;
  return { narration: last.narration, spokenMode: isMode(spokenMode) ? spokenMode : settings.mode };
};

const getEpisodeAudio = async (workDir: string, episode: Episode): Promise<string> => {
  const audioPath = join(workDir, "audio", `${episode.label}.mp3`);
  await downloadFile(episode.audioUrl, audioPath);
  return audioPath;
};

const getTranscript = async (workDir: string, episode: Episode): Promise<string> =>
  transcribe(await getEpisodeAudio(workDir, episode), join(workDir, "transcripts", `${episode.label}.txt`));

/** Whether an episode still needs a paid summary, which matters for cost estimates. */
export const hasSummary = (workDir: string, episode: Episode): boolean => readSummary(workDir, episode) !== undefined;

const readSummary = (workDir: string, episode: Episode): EpisodeSummary | undefined => {
  const path = join(workDir, "summaries", `${episode.label}.json`);
  if (!existsSync(path)) return undefined;
  const cached = JSON.parse(readFileSync(path, "utf8")) as { version?: number; summary?: unknown };
  const parsed = EpisodeSummarySchema.safeParse(cached.summary);
  return cached.version === SUMMARY_VERSION && parsed.success ? parsed.data : undefined;
};

const getSummary = async (writer: RecapWriter, show: Show, workDir: string, episode: Episode): Promise<EpisodeSummary> => {
  const cached = readSummary(workDir, episode);
  if (cached) return cached;
  const summary = await summarizeEpisode(writer, show.title, episode, await getTranscript(workDir, episode));
  mkdirSync(join(workDir, "summaries"), { recursive: true });
  writeFileSync(
    join(workDir, "summaries", `${episode.label}.json`),
    `${JSON.stringify({ version: SUMMARY_VERSION, model: writer.name, summary }, null, 2)}\n`,
  );
  return summary;
};

interface NarrationRequest {
  writer: RecapWriter;
  show: Show;
  workDir: string;
  target: Episode;
  context: Episode[];
  settings: RecapSettings;
  recapJson: string;
  log: Log;
  signal?: AbortSignal;
}

const createNarration = async (request: NarrationRequest): Promise<Narration> => {
  const { writer, show, workDir, target, context, settings, recapJson, log, signal } = request;
  const { mode, tone, instructions } = settings;
  log(`${show.title}: preparing "${target.title}" from ${context.length} earlier episodes with ${writer.name}`);

  log("Transcribing and summarizing earlier episodes");
  const summaries: LabeledSummary[] = [];
  for (const episode of context) {
    signal?.throwIfAborted();
    summaries.push({ episode, summary: await getSummary(writer, show, workDir, episode) });
  }

  signal?.throwIfAborted();
  log("Reading the upcoming episode privately");
  const targetTranscript = await getTranscript(workDir, target);
  const brief = await createBrief(writer, show.title, target, summaries, targetTranscript);

  // Research modes fall back to a plain recap when there is too little real-world background to explain.
  let writingMode: Mode = mode;
  let research: Awaited<ReturnType<typeof researchContext>> | undefined;
  if (usesResearch(mode)) {
    const references = earlierReferences(brief, summaries);
    if (references.length < MIN_OUTSIDE_REFERENCES) {
      log("This episode has few real-world references to explain, so writing a Recap instead");
      writingMode = "recap";
    } else {
      signal?.throwIfAborted();
      log(`Researching ${references.length} real-world references on the web: ${references.join("; ")}`);
      research = await researchContext(writer, show.title, target, summaries, brief, references);
      log(`Kept ${research.facts.length} cited facts from ${research.sources.length} sources`);
      if (research.facts.length < MIN_OUTSIDE_FACTS) {
        log("Too few cited facts for a briefing, so writing a Recap instead");
        writingMode = "recap";
      }
    }
  }
  const contextFacts = writingMode === mode ? research?.facts : undefined;

  signal?.throwIfAborted();
  log(`Writing the ${MODES[writingMode].label} recap`);
  const scriptRequest = {
    showTitle: show.title,
    target,
    mode: writingMode,
    summaries,
    brief,
    contextFacts,
    tone: tone ?? undefined,
    listenerPreferences: instructions ?? undefined,
  };
  const check = (text: string, earlier: LabeledSummary[], facts = contextFacts) =>
    checkScript(writer, target, text, earlier, brief.spoilerTopics, targetTranscript, facts);

  let narration = await writeScript(writer, scriptRequest);
  let result = await check(narration, summaries);
  const attempts = [{ narration, check: result }];

  if (result.verdict === "fail") {
    signal?.throwIfAborted();
    log(`Check found ${result.issues.length} issue(s), rewriting`);
    narration = await writeScript(writer, { ...scriptRequest, previousIssues: result.issues });
    result = await check(narration, summaries);
    attempts.push({ narration, check: result });
  }
  if (result.verdict === "fail") {
    signal?.throwIfAborted();
    log("Still failing, falling back to a plain recap of the most recent episodes only");
    const recent = summaries.slice(-2);
    if (usesResearch(writingMode)) writingMode = "recap";
    const fallback = { ...scriptRequest, mode: writingMode, summaries: recent, brief: undefined, contextFacts: undefined };
    narration = await writeScript(writer, fallback);
    result = await check(narration, recent, undefined);
    attempts.push({ narration, check: result });
  }

  const usedFacts = result.verdict === "pass" && usesResearch(writingMode) ? contextFacts : undefined;
  const saved = {
    target: target.title,
    mode,
    spokenMode: writingMode,
    model: writer.name,
    effort: settings.effort,
    tone,
    instructions,
    brief,
    research,
    attempts,
  };
  writeFileSync(recapJson, `${JSON.stringify(saved, null, 2)}\n`);
  const sourcesPath = recapJson.replace(/\.json$/, ".sources.txt");
  rmSync(sourcesPath, { force: true });
  if (usedFacts?.length) {
    writeFileSync(sourcesPath, formatSourceNotes(usedFacts));
    log(`Sources for show notes: ${sourcesPath}`);
  }
  if (result.verdict === "fail") {
    throw new Error(`Could not produce a recap that passes the spoiler check. Details: ${recapJson}`);
  }
  return { narration, spokenMode: writingMode };
};

/** Plain-text source list, suitable for an episode's show notes. */
const formatSourceNotes = (facts: ContextFact[]): string => {
  const sources = new Map<string, string>();
  for (const { sources: factSources } of facts) {
    for (const { title, url } of factSources) sources.set(url, title);
  }
  return `Background sources (AI-selected, unofficial):\n${[...sources]
    .map(([url, title]) => `- ${title}: ${url}`)
    .join("\n")}\n`;
};

const renderAudio = async (
  workDir: string,
  base: string,
  target: Episode,
  spoken: string,
  settings: RecapSettings,
  log: Log,
): Promise<{ audioPath: string; recapSeconds: number }> => {
  log("Narrating and splicing");
  const temp = `${base}.tmp`;
  mkdirSync(temp, { recursive: true });
  try {
    const narrationText = join(temp, "narration.txt");
    writeFileSync(narrationText, spoken);
    await speak(narrationText, join(temp, "narration.aiff"), {
      voice: settings.voice ?? undefined,
      wordsPerMinute: settings.wordsPerMinute ?? undefined,
    });
    await toPcmWav(join(temp, "narration.aiff"), join(temp, "narration.wav"));
    await toPcmWav(join(workDir, "audio", `${target.label}.mp3`), join(temp, "episode.wav"));

    const recapAudio = readWav(join(temp, "narration.wav"));
    const episodeAudio = readWav(join(temp, "episode.wav"));
    if (!sameFormat(recapAudio.format, episodeAudio.format)) throw new Error("Recap and episode audio formats differ.");
    // Match the narrator to the episode's overall level so there is no jump at the splice.
    const narration = matchLevel(recapAudio.data, rmsLevel(episodeAudio.data));
    writeJoinedWav(join(temp, "joined.wav"), episodeAudio.format, [
      silence(episodeAudio.format, 300),
      narration,
      silence(episodeAudio.format, settings.pauseSeconds * 1000),
      episodeAudio.data,
    ]);

    const audioPath = `${base}.m4a`;
    await encodeAac(join(temp, "joined.wav"), audioPath);
    const recapSeconds = recapAudio.data.length / episodeAudio.format.readUInt16LE(12) / 44_100;
    log(`Recap is ${Math.round(recapSeconds)}s, full episode ${Math.round((await durationSeconds(audioPath)) / 60)} min`);
    return { audioPath, recapSeconds };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
};

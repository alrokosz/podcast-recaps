import { contextEpisodes, type Episode, type Show } from "./feed.js";
import type { Mode } from "./modes.js";
import { hasSavedRecap, hasSummary, type RecapSettings } from "./pipeline.js";

/**
 * Typical Claude Opus 5.5 costs at low effort, measured on Revolutions, The Bright Sessions, and Serial.
 * Estimates round up, since a failed spoiler check means extra rewrite calls.
 */
const OPUS_RECAP_USD: Record<Mode, number> = {
  "previously-on": 0.3,
  recap: 0.22,
  "further-context": 0.55,
};
const OPUS_SUMMARY_USD = 0.06;
/** Web searches cost the same on every model. */
const RESEARCH_SEARCH_USD = 0.05;

/** How much cheaper each model's tokens are than Opus 5.5's. */
const TOKEN_SCALE: Record<string, number> = {
  "claude-opus-5-5": 1,
  "claude-haiku-5-5": 0.1 / 4,
};

export interface EpisodeEstimate {
  episode: Episode;
  estimatedCostUsd: number;
  /** Earlier episodes this job will summarize for the first time. */
  newSummaries: number;
  reusesSavedRecap: boolean;
}

/**
 * Estimates each episode in a batch, in order. An earlier episode's summary is paid for once,
 * by the first job that needs it, and episodes with a saved passing recap cost nothing.
 */
export const estimateBatch = (workDir: string, show: Show, targets: Episode[], settings: RecapSettings): EpisodeEstimate[] => {
  const scale = TOKEN_SCALE[settings.model] ?? 1;
  const summarized = new Set<string>();
  return [...targets]
    .sort((a, b) => a.index - b.index)
    .map((episode) => {
      if (hasSavedRecap(workDir, episode, settings)) {
        return { episode, estimatedCostUsd: 0, newSummaries: 0, reusesSavedRecap: true };
      }
      let newSummaries = 0;
      for (const earlier of contextEpisodes(show, episode)) {
        if (summarized.has(earlier.guid)) continue;
        summarized.add(earlier.guid);
        if (!hasSummary(workDir, earlier)) newSummaries++;
      }
      const searches = settings.mode === "further-context" ? RESEARCH_SEARCH_USD : 0;
      const tokens = (OPUS_RECAP_USD[settings.mode] - searches + newSummaries * OPUS_SUMMARY_USD) * scale;
      return { episode, estimatedCostUsd: round(tokens + searches), newSummaries, reusesSavedRecap: false };
    });
};

const round = (usd: number): number => Math.round(usd * 1000) / 1000;

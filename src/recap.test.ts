import assert from "node:assert/strict";
import { test } from "node:test";
import type { Episode } from "./feed.js";
import { type Brief, earlierReferences, type LabeledSummary } from "./recap.js";

const summary = (label: string) =>
  ({
    episode: { label } as Episode,
    summary: { summary: "", keyEvents: [], people: [], openThreads: [] },
  }) satisfies LabeledSummary;

test("research only covers references an earlier episode mentions", () => {
  const brief: Brief = {
    threads: [],
    spoilerTopics: [],
    explainedInEpisode: [],
    outsideReferences: [
      { name: "Leakin Park", mentionedIn: ["EP3"] },
      { name: "Cotton Club", mentionedIn: ["104"] },
      { name: "Thirty Years' War", mentionedIn: [] },
    ],
  };
  assert.deepEqual(earlierReferences(brief, [summary("ep1"), summary("ep3")]), ["Leakin Park"]);
});

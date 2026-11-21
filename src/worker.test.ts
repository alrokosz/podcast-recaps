import assert from "node:assert/strict";
import { test } from "node:test";
import type { Episode, Show } from "./feed.js";
import { DEFAULT_SETTINGS, type PreparedRecap } from "./pipeline.js";
import { Store } from "./store.js";
import { type JobRunner, Worker } from "./worker.js";

const episode = (index: number): Episode => ({
  index,
  guid: `guid-${index}`,
  title: `${index}- Episode ${index}`,
  label: String(index),
  season: 1,
  publishedAt: new Date(Date.UTC(2020, 0, index + 1)),
  audioUrl: `https://example.com/${index}.mp3`,
  durationSeconds: 1800,
});

const show: Show = { title: "Test Show", slug: "test-show", episodes: [0, 1, 2, 3].map(episode) };

const done = (): PreparedRecap => ({ spoken: "text", spokenMode: "previously-on", reused: false, textPath: "/tmp/x.txt" });

const setup = (runJob: JobRunner) => {
  const store = new Store(":memory:");
  const row = store.saveShow("https://example.com/feed.xml", show);
  const worker = new Worker(store, { dataDir: "/unused", getApiKey: async () => "key", runJob });
  const queue = (indexes: number[], cost = 0.3) =>
    store.enqueue(
      row.id,
      indexes.map((i) => ({ episode: show.episodes[i] as Episode, estimatedCostUsd: cost })),
      DEFAULT_SETTINGS,
    );
  return { store, worker, queue, showId: row.id };
};

test("runs a batch in episode order and records results", async () => {
  const order: string[] = [];
  const { store, worker, queue } = setup(async (job) => {
    order.push(job.episodeGuid);
    return done();
  });
  queue([3, 1, 2]);
  worker.kick();
  await worker.idle();
  assert.deepEqual(order, ["guid-1", "guid-2", "guid-3"]);
  assert.ok(store.listJobs().every(({ status }) => status === "done"));
});

test("asking to prepare an episode twice reuses the active job", () => {
  const { store, queue } = setup(async () => done());
  const [first] = queue([1]);
  const [second] = queue([1]);
  assert.equal(first?.id, second?.id);
  assert.equal(store.listJobs().length, 1);
});

test("holds jobs when the monthly cap would be exceeded, and resumes when it is raised", async () => {
  const ran: string[] = [];
  const { store, worker, queue } = setup(async (job) => {
    ran.push(job.episodeGuid);
    store.recordUsage(job.id, {
      at: new Date().toISOString(),
      step: "test",
      model: "claude-opus-5-5",
      effort: "low",
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      webSearches: 0,
      estimatedCostUsd: 0.3,
    });
    return done();
  });
  worker.setMonthlyCap(0.5);
  await worker.idle();
  queue([1, 2, 3]);
  worker.kick();
  await worker.idle();
  assert.deepEqual(ran, ["guid-1"]);
  assert.equal(store.listJobs({ statuses: ["waiting_for_budget"] }).length, 2);
  assert.equal(worker.budget().spentThisMonthUsd, 0.3);

  worker.setMonthlyCap(2);
  await worker.idle();
  assert.deepEqual(ran, ["guid-1", "guid-2", "guid-3"]);
});

test("a failed job records its error and the queue continues", async () => {
  const { store, worker, queue } = setup(async (job) => {
    if (job.episodeGuid === "guid-1") throw new Error("Download failed (404)");
    return done();
  });
  queue([1, 2]);
  worker.kick();
  await worker.idle();
  const [second, first] = store.listJobs();
  assert.equal(first?.status, "failed");
  assert.equal(first?.error, "Download failed (404)");
  assert.equal(second?.status, "done");
});

test("cancelling stops the running job and skips queued ones", async () => {
  let release: () => void = () => {};
  const { store, worker, queue } = setup(
    (_, { signal }) =>
      new Promise((_resolve, reject) => {
        release = () => reject(new Error("aborted"));
        signal.addEventListener("abort", () => release());
      }),
  );
  const [running, queued] = queue([1, 2]);
  worker.kick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(worker.currentJobId, running?.id);
  worker.cancelBatch(running?.batchId ?? "");
  await worker.idle();
  assert.equal(store.getJob(running?.id ?? 0)?.status, "cancelled");
  assert.equal(store.getJob(queued?.id ?? 0)?.status, "cancelled");
});

test("jobs interrupted by a restart are queued again", async () => {
  const { store, worker, queue } = setup(async () => done());
  const [job] = queue([1]);
  store.updateJob(job?.id ?? 0, { status: "running" });
  worker.start();
  await worker.idle();
  assert.equal(store.getJob(job?.id ?? 0)?.status, "done");
});

test("refreshing a feed keeps one row per episode", () => {
  const { store, showId } = setup(async () => done());
  store.saveShow("https://example.com/feed.xml", { ...show, title: "Renamed" });
  assert.equal(store.loadShow(showId)?.episodes.length, 4);
  assert.equal(store.getShow(showId)?.title, "Renamed");
});

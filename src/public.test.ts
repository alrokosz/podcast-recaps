import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { type Episode, parseFeed, type Show } from "./feed.js";
import { coversFile, episodeKey } from "./feedxml.js";
import { DEFAULT_SETTINGS } from "./pipeline.js";
import { createPublicServer, PUBLIC_BASE_URL_KEY } from "./public.js";
import { type ShowRow, Store } from "./store.js";
import { Worker } from "./worker.js";

const episode = (index: number, extra: Partial<Episode> = {}): Episode => ({
  index,
  guid: `guid/${index}?x=1`,
  title: `${index}- Episode ${index}`,
  label: String(index),
  season: 1,
  publishedAt: new Date(Date.UTC(2020, 0, index + 1)),
  audioUrl: `https://example.com/${index}.mp3?a=1&b=2`,
  durationSeconds: 1800,
  ...extra,
});

const show: Show = {
  title: "Test & <Show>",
  slug: "test-show",
  author: "Host",
  imageUrl: "https://example.com/art.jpg",
  episodes: [
    episode(0),
    episode(1, { title: `1- Tricky "quotes" & <tags>`, description: "<p>Notes with ]]> inside</p>" }),
    episode(2),
  ],
};

let base = "";
let dir = "";
let store: Store;
let row: ShowRow;
let close = () => {};
const AUDIO = Buffer.from("0123456789".repeat(100));

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "recaps-public-"));
  store = new Store(":memory:");
  row = store.saveShow("https://example.com/feed.xml", show);
  store.setSetting(PUBLIC_BASE_URL_KEY, "https://mac.example.ts.net");

  // Episode 1 has a finished recap.
  const audioPath = join(dir, "1-previously-on.m4a");
  writeFileSync(audioPath, AUDIO);
  const [job] = store.enqueue(row.id, [{ episode: show.episodes[1] as Episode, estimatedCostUsd: 0.3 }], DEFAULT_SETTINGS);
  store.updateJob(job?.id ?? 0, { status: "done", audioPath, finishedAt: new Date().toISOString() });

  const worker = new Worker(store, { dataDir: dir, getApiKey: async () => "key", runJob: () => new Promise(() => {}) });
  const server = createPublicServer({ store, worker, dataDir: dir, hasApiKey: async () => true });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => {
    server.closeAllConnections();
    server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
});

after(() => close());

test("the cloned feed is valid, private, and swaps in prepared audio", async () => {
  const response = await fetch(`${base}/feed/${row.feedToken}.xml`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("x-robots-tag") ?? "", /noindex/);
  const xml = await response.text();
  assert.match(xml, /<itunes:block>Yes<\/itunes:block>/);

  const parsed = parseFeed(xml);
  assert.equal(parsed.title, "Test & <Show> (Recaps)");
  const byTitle = new Map(parsed.episodes.map((e) => [e.title, e]));
  const prepared = byTitle.get(`1- Tricky "quotes" & <tags> (with recap)`);
  assert.ok(prepared, "prepared episode is marked");
  assert.match(prepared.audioUrl, new RegExp(`^https://mac.example.ts.net/audio/${row.feedToken}/\\d+\\.m4a$`));
  assert.match(prepared.description ?? "", /Notes with \]\]> inside/);
  assert.equal(byTitle.get("2- Episode 2")?.audioUrl, "https://example.com/2.mp3?a=1&b=2");
  assert.equal(prepared.guid, `podcast-recaps:guid/1?x=1`);
});

test("serves audio ranges and tracks complete delivery, ignoring the streaming probe", async () => {
  const xml = await (await fetch(`${base}/feed/${row.feedToken}.xml`)).text();
  const audioPath = new URL(/audio\/[^"]+\.m4a/.exec(xml)?.[0] ?? "", "http://x").pathname;
  const url = `${base}${audioPath}`;
  const jobId = Number(/(\d+)\.m4a$/.exec(audioPath)?.[1]);

  const probe = await fetch(url, { headers: { Range: "bytes=0-1" } });
  assert.equal(probe.status, 206);
  assert.equal(await probe.text(), "01");
  assert.equal(store.deliveredRanges(jobId).ranges.length, 0);

  const firstHalf = await fetch(url, { headers: { Range: "bytes=0-499" } });
  assert.equal((await firstHalf.arrayBuffer()).byteLength, 500);
  const secondHalf = await fetch(url, { headers: { Range: "bytes=500-" } });
  assert.equal(secondHalf.headers.get("content-range"), "bytes 500-999/1000");
  await secondHalf.arrayBuffer();
  // Deliveries are recorded when the response closes.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const { ranges, fileSize } = store.deliveredRanges(jobId);
  assert.ok(coversFile(ranges, fileSize ?? 0));

  assert.equal((await fetch(url, { headers: { Range: "bytes=5000-" } })).status, 416);
});

test("unknown tokens and local API paths are not served", async () => {
  assert.equal((await fetch(`${base}/feed/${"x".repeat(43)}.xml`)).status, 404);
  assert.equal((await fetch(`${base}/api/status`)).status, 404);
  assert.equal((await fetch(`${base}/audio/${row.feedToken}/999.m4a`)).status, 404);
});

test("Prepare next shows a confirmation, and repeated submits queue one job", async () => {
  const url = `${base}/next/${row.feedToken}/${episodeKey(show.episodes[1]?.guid ?? "")}`;
  const confirm = await (await fetch(url)).text();
  assert.match(confirm, /2- Episode 2/);
  assert.match(confirm, /<form method="post">/);
  assert.equal(store.listJobs({ statuses: ["queued"] }).length, 0, "viewing the page never starts a job");

  const submit = await fetch(url, { method: "POST", redirect: "manual" });
  assert.equal(submit.status, 303);
  await fetch(url, { method: "POST", redirect: "manual" });
  const queued = store.listJobs({ statuses: ["queued", "running"] });
  assert.equal(queued.length, 1);
  assert.equal(queued[0]?.episodeGuid, show.episodes[2]?.guid);
  assert.match(await (await fetch(url)).text(), /Preparing/);
});

test("coversFile needs contiguous ranges", () => {
  assert.ok(coversFile([[0, 9]], 10));
  assert.ok(coversFile([[5, 9], [0, 5]], 10));
  assert.ok(!coversFile([[0, 4], [6, 9]], 10));
  assert.ok(!coversFile([[0, 8]], 10));
});

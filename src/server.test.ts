import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Episode, Show } from "./feed.js";
import { createApi } from "./server.js";
import { Store } from "./store.js";
import { Worker } from "./worker.js";

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
const show: Show = { title: "Test Show", slug: "test-show", episodes: [0, 1, 2].map(episode) };

let base = "";
let close = () => {};
let dataDir = "";

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "recaps-api-"));
  const store = new Store(":memory:");
  // The runner never finishes, so jobs stay visible as queued or running.
  const worker = new Worker(store, { dataDir, getApiKey: async () => "key", runJob: () => new Promise(() => {}) });
  const server = createApi({
    store,
    worker,
    dataDir,
    hasApiKey: async () => true,
    fetchFeed: async () => ({ show, xml: "" }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => {
    server.closeAllConnections();
    server.close();
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  };
});

after(() => close());

const call = (path: string, init: RequestInit & { json?: unknown } = {}) =>
  fetch(`${base}${path}`, {
    ...init,
    headers: { ...(init.json === undefined ? {} : { "Content-Type": "application/json" }), ...init.headers },
    body: init.json === undefined ? init.body : JSON.stringify(init.json),
  });

test("adds a show, estimates, and queues a range without duplicates", async () => {
  const added = await (await call("/api/shows", { method: "POST", json: { feedUrl: "https://example.com/feed.xml" } })).json();
  assert.equal(added.title, "Test Show");

  const estimate = await (await call(`/api/shows/${added.id}/estimate`, { method: "POST", json: { from: "0" } })).json();
  // Episode 0 has nothing earlier to recap, so it is skipped.
  assert.deepEqual(
    estimate.episodes.map(({ label }: { label: string }) => label),
    ["1", "2"],
  );
  // Episode 1 pays to summarize episode 0, and episode 2 pays to summarize episode 1.
  assert.equal(estimate.totalUsd, 0.72);

  const first = await (await call(`/api/shows/${added.id}/prepare`, { method: "POST", json: { from: "1" } })).json();
  const again = await (await call(`/api/shows/${added.id}/prepare`, { method: "POST", json: { from: "1" } })).json();
  assert.deepEqual(
    again.map(({ id }: { id: number }) => id),
    first.map(({ id }: { id: number }) => id),
  );
});

test("rejects invalid settings with a readable message", async () => {
  const response = await call("/api/shows/1/estimate", { method: "POST", json: { from: "1", settings: { mode: "nope" } } });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /mode/);
});

test("refuses requests from other sites and hosts", async () => {
  const crossSite = await call("/api/budget", {
    method: "PUT",
    json: { monthlyCapUsd: 100 },
    headers: { Origin: "https://evil.example" },
  });
  assert.equal(crossSite.status, 403);

  // fetch() won't send a custom Host header, so use http.request to imitate DNS rebinding.
  const rebindingStatus = await new Promise<number | undefined>((resolve, reject) => {
    const { port } = new URL(base);
    request({ host: "127.0.0.1", port, path: "/api/status", headers: { Host: "evil.example:8786" } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    })
      .on("error", reject)
      .end();
  });
  assert.equal(rebindingStatus, 403);

  const formPost = await call("/api/budget", {
    method: "PUT",
    body: "monthlyCapUsd=100",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  assert.equal(formPost.status, 415);
});

import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { after, before, test } from "node:test";
import type { Episode, Show } from "./feed.js";
import { PacketQueue, SessionWriter } from "./packets.js";
import { createApi } from "./server.js";
import { Store } from "./store.js";
import { Worker } from "./worker.js";
import { z } from "zod";

const episode = (index: number): Episode => ({
  index,
  guid: `guid-${index}`,
  title: `1.${index}- Episode ${index}`,
  label: `1.${index}`,
  season: 1,
  publishedAt: new Date(Date.UTC(2020, 0, index + 1)),
  audioUrl: `https://example.com/${index}.mp3`,
  durationSeconds: 1800,
});
const show: Show = { title: "Test Show", slug: "test-show", episodes: [1, 2, 3].map(episode) };

let dataDir = "";
let packetDir = "";
let store: Store;
let packets: PacketQueue;
let server: ReturnType<typeof createApi>;
let mcp: ChildProcessWithoutNullStreams;
const waiting = new Map<number, (message: { result?: unknown; error?: unknown }) => void>();
let nextId = 1;

/** Sends one JSON-RPC request to the plugin's MCP server and waits for the reply. */
const rpc = (method: string, params?: unknown) =>
  new Promise<{ result?: any; error?: any }>((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });

const callTool = async (name: string, args: Record<string, unknown> = {}) => {
  const { result } = await rpc("tools/call", { name, arguments: args });
  const text = result.content[0].text as string;
  return { isError: Boolean(result.isError), text, json: result.isError ? undefined : JSON.parse(text) };
};

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "recaps-plugin-"));
  packetDir = join(dataDir, "packets");
  store = new Store(":memory:");
  packets = new PacketQueue();
  // Jobs don't run here; the test adds packets itself, as a running job would.
  const worker = new Worker(store, { dataDir, getApiKey: async () => undefined, runJob: () => new Promise(() => {}) });
  server = createApi({ store, worker, packets, dataDir, hasApiKey: async () => false, fetchFeed: async () => ({ show, xml: "" }) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  mcp = spawn(process.execPath, [join(import.meta.dirname, "../plugin/mcp/server.mjs")], {
    env: { ...process.env, RECAPS_API: `http://127.0.0.1:${port}`, RECAPS_PACKET_DIR: packetDir },
  });
  createInterface({ input: mcp.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
  });
});

after(() => {
  mcp.kill();
  server.closeAllConnections();
  server.close();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test("speaks MCP and lists the recap tools", async () => {
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test" } });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.deepEqual(init.result.capabilities, { tools: {} });
  mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  const { result } = await rpc("tools/list");
  const names = result.tools.map(({ name }: { name: string }) => name);
  for (const name of ["status", "add_show", "estimate", "queue_recaps", "next_packet", "submit_result", "release_packet"]) {
    assert.ok(names.includes(name), `missing tool ${name}`);
  }
  assert.ok((await rpc("no/such/method")).error);
});

test("adds a show, estimates at no API cost, and queues Claude Code jobs", async () => {
  const added = await callTool("add_show", { feedUrl: "https://example.com/feed.xml" });
  assert.equal(added.json.title, "Test Show");

  const estimate = await callTool("estimate", { showId: added.json.id, from: "1.2", to: "1.3" });
  assert.equal(estimate.json.recapsToWrite, 2);
  assert.equal(estimate.json.apiCostUsd, 0);

  const queued = await callTool("queue_recaps", { showId: added.json.id, from: "1.2", to: "1.3", mode: "recap" });
  assert.equal(queued.isError, false, queued.text);
  assert.equal(queued.json.queuedJobs, 2);
  const jobs = store.listJobs();
  assert.ok(jobs.every(({ settings }) => settings.model === "claude-code" && settings.mode === "recap"));

  const unknown = await callTool("estimate", { showId: added.json.id, from: "9.9" });
  assert.equal(unknown.isError, true);
  assert.match(unknown.text, /No episode "9.9"/);
});

test("claims a packet into a private file, then submits a fixed result", async () => {
  const job = store.listJobs().find(({ episodeGuid }) => episodeGuid === "guid-2");
  assert.ok(job);
  const result = new SessionWriter(packets, job.id).generate({
    step: "check 1.2",
    system: "SYSTEM TEXT",
    prompt: "PROMPT TEXT",
    schema: z.object({ verdict: z.enum(["pass", "fail"]) }),
    independentReview: true,
  });

  const claimed = await callTool("next_packet", { waitSeconds: 1 });
  assert.equal(claimed.json.agent, "recap-checker");
  const { id, file, episode: label } = claimed.json.packet;
  assert.equal(label, "1.2 · 1.2- Episode 2");
  assert.equal(statSync(file).mode & 0o777, 0o600, "packet files are private");
  const text = readFileSync(file, "utf8");
  assert.match(text, /SYSTEM TEXT/);
  assert.match(text, /PROMPT TEXT/);
  assert.match(text, /"enum": \[\s*"pass",\s*"fail"\s*\]/);

  const rejected = await callTool("submit_result", { packetId: id, output: { verdict: "maybe" } });
  assert.equal(rejected.isError, true);
  assert.match(rejected.text, /verdict/);
  assert.ok(existsSync(file), "a rejected result keeps the packet file for another try");

  // Accepts JSON passed as a string too.
  const accepted = await callTool("submit_result", { packetId: id, output: '{"verdict":"pass"}' });
  assert.equal(accepted.isError, false);
  assert.deepEqual(await result, { verdict: "pass" });
  assert.equal(existsSync(file), false, "the packet file is deleted once submitted");

  const empty = await callTool("next_packet", { waitSeconds: 0 });
  assert.equal(empty.json.packet, null);
});

test("explains when the service isn't running", async () => {
  const offline = spawn(process.execPath, [join(import.meta.dirname, "../plugin/mcp/server.mjs")], {
    env: { ...process.env, RECAPS_API: "http://127.0.0.1:9" },
  });
  const reply = new Promise<string>((resolve) =>
    createInterface({ input: offline.stdout }).once("line", (line) => resolve(JSON.parse(line).result.content[0].text)),
  );
  offline.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "status" } })}\n`);
  assert.match(await reply, /isn't running/);
  offline.kill();
});

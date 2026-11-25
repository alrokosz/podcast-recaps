import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { PacketQueue, SESSION_WRITER, SessionWriter } from "./packets.js";

const Schema = z.object({ verdict: z.enum(["pass", "fail"]) });

test("a session writer turns each step into a packet and returns the validated result", async () => {
  const queue = new PacketQueue();
  const writer = new SessionWriter(queue, 7);
  assert.equal(writer.name, SESSION_WRITER);

  const result = writer.generate({ step: "check 1.5", system: "s", prompt: "p", schema: Schema, independentReview: true });
  const packet = await queue.next(1000);
  assert.ok(packet);
  assert.equal(packet.jobId, 7);
  assert.equal(packet.independent, true);
  assert.deepEqual((packet.outputSchema as { properties: object }).properties, {
    verdict: { type: "string", enum: ["pass", "fail"] },
  });

  const rejected = queue.submit(packet.id, { verdict: "maybe" });
  assert.equal(rejected.ok, false);
  assert.ok(queue.get(packet.id), "an invalid result leaves the packet open");
  assert.deepEqual(queue.submit(packet.id, { verdict: "pass" }), { ok: true });
  assert.deepEqual(await result, { verdict: "pass" });
  assert.equal(queue.list().length, 0);
});

test("a waiting session wakes up when a packet arrives", async () => {
  const queue = new PacketQueue();
  const waiting = queue.next(5000);
  const writer = new SessionWriter(queue, 1);
  void writer.generate({ step: "brief 2", system: "s", prompt: "p", schema: Schema });
  assert.equal((await waiting)?.step, "brief 2");
});

test("claimed packets are leased, and come back after release or when the lease runs out", async () => {
  let now = new Date("2026-11-25T12:00:00Z");
  const queue = new PacketQueue(() => now, 60_000);
  void new SessionWriter(queue, 1).generate({ step: "script 2", system: "s", prompt: "p", schema: Schema });

  const first = await queue.next();
  assert.ok(first);
  assert.equal(await queue.next(), undefined);
  assert.ok(queue.release(first.id));
  assert.equal((await queue.next())?.id, first.id);

  now = new Date(now.getTime() + 61_000);
  assert.equal((await queue.next())?.id, first.id, "an abandoned claim expires");
});

test("cancelling a job removes its packets", async () => {
  const queue = new PacketQueue();
  const controller = new AbortController();
  const result = new SessionWriter(queue, 1, { signal: controller.signal }).generate({
    step: "summarize 1",
    system: "s",
    prompt: "p",
    schema: Schema,
  });
  assert.equal(queue.list().length, 1);
  controller.abort(new Error("Cancelled."));
  await assert.rejects(result, /Cancelled/);
  assert.equal(queue.list().length, 0);
});

test("research results must cite sources that exist", async () => {
  const queue = new PacketQueue();
  const result = new SessionWriter(queue, 1).research({ step: "research 3", system: "s", prompt: "p", maxSearches: 5 });
  const packet = await queue.next();
  assert.ok(packet);
  assert.equal(packet.maxSearches, 5);

  const source = { id: 1, title: "Encyclopedia", url: "https://example.com/a", excerpts: ["A quoted passage."] };
  const missing = queue.submit(packet.id, { notes: "Claim [1]. Another [2].", sources: [source] });
  assert.equal(missing.ok, false);
  assert.match(missing.ok ? "" : missing.error, /cite \[2\]/);
  const notHttp = queue.submit(packet.id, { notes: "Claim [1].", sources: [{ ...source, url: "file:///etc/passwd" }] });
  assert.equal(notHttp.ok, false);

  assert.deepEqual(queue.submit(packet.id, { notes: "Claim [1].", sources: [source] }), { ok: true });
  assert.equal((await result).sources[0]?.url, "https://example.com/a");
});

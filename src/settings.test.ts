import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS } from "./pipeline.js";
import { resolveSettings } from "./settings.js";

test("unset options keep their defaults", () => {
  assert.deepEqual(resolveSettings({ model: undefined, mode: undefined, pauseSeconds: undefined }), DEFAULT_SETTINGS);
});

test("given options override defaults, and settings serialize the same regardless of input order", () => {
  const a = resolveSettings({ tone: "playful", mode: "recap" });
  const b = resolveSettings({ mode: "recap", tone: "playful" });
  assert.equal(a.mode, "recap");
  assert.equal(a.model, "claude-opus-5-5");
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test("rejects unknown fields and out-of-range values", () => {
  assert.throws(() => resolveSettings({ voice: "Samantha; rm -rf" }));
  assert.throws(() => resolveSettings({ pauseSeconds: 60 }));
  assert.throws(() => resolveSettings({ apiKey: "sk-ant-x" }));
});

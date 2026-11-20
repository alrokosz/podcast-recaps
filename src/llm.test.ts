import assert from "node:assert/strict";
import { test } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { collectCitations } from "./llm.js";

const cite = (url: string, cited_text: string) => ({
  type: "web_search_result_location" as const,
  url,
  title: `Title of ${url}`,
  cited_text,
  encrypted_index: "",
});

test("numbers each cited page once and marks the notes", () => {
  const blocks = [
    { type: "server_tool_use", id: "1", name: "web_search", input: {} },
    { type: "text", text: "Let me search.", citations: null },
    { type: "text", text: "Pym led the Commons.", citations: [cite("https://a.example", "Pym led")] },
    {
      type: "text",
      text: " Strafford was executed.",
      citations: [cite("https://b.example", "Strafford"), cite("https://a.example", "executed")],
    },
  ] as unknown as Anthropic.Beta.BetaContentBlock[];

  const { notes, sources } = collectCitations(blocks);
  assert.equal(notes, "Let me search.Pym led the Commons. [1] Strafford was executed. [2] [1]");
  assert.deepEqual(
    sources.map(({ id, url, excerpts }) => ({ id, url, excerpts })),
    [
      { id: 1, url: "https://a.example", excerpts: ["Pym led", "executed"] },
      { id: 2, url: "https://b.example", excerpts: ["Strafford"] },
    ],
  );
});

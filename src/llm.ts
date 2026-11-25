import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { appendFileSync } from "node:fs";
import type { z } from "zod";
import type { GenerateRequest, RecapWriter, ResearchRequest, ResearchResult, Source } from "./writer.js";

export type Effort = "low" | "medium" | "high";

/** USD per million tokens. Haiku's rate applies to prompts up to 100K tokens. */
const PRICES: Record<string, { input: number; output: number }> = {
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
};

/** Web search is billed per search, on top of tokens. */
const USD_PER_SEARCH = 10 / 1000;

/** Models that support server-side refusal fallbacks. */
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-2"]);

/** How many times to resume a long server-side search turn before giving up. */
const MAX_CONTINUATIONS = 4;

type Usage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  server_tool_use?: { web_search_requests: number } | null;
};

export interface UsageRecord {
  at: string;
  step: string;
  model: string;
  effort: Effort;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  webSearches: number;
  estimatedCostUsd: number;
}

export interface LlmOptions {
  /** Defaults to the ANTHROPIC_API_KEY environment variable. */
  apiKey?: string;
  /** Appends each call's usage to this JSONL file. */
  usageLogPath?: string;
  onUsage?: (record: UsageRecord) => void;
}

/** Writes recaps through the Anthropic API with the user's own key. */
export class Llm implements RecapWriter {
  private readonly client: Anthropic;
  totalCost = 0;

  constructor(
    readonly model: string,
    readonly effort: Effort,
    private readonly options: LlmOptions = {},
  ) {
    this.client = new Anthropic(options.apiKey ? { apiKey: options.apiKey } : {});
  }

  get name(): string {
    return this.model;
  }

  async generate<Schema extends z.ZodType>(request: GenerateRequest<Schema>): Promise<z.infer<Schema>> {
    const response = await this.client.beta.messages.parse({
      model: this.model,
      max_tokens: request.maxTokens ?? 16_000,
      ...(FALLBACK_MODELS.has(this.model)
        ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
        : {}),
      output_config: { effort: this.effort, format: betaZodOutputFormat(request.schema) },
      system: request.system,
      messages: [{ role: "user", content: request.prompt }],
    });

    this.recordUsage(request.step, response.model, response.usage);

    if (response.stop_reason === "refusal") {
      throw new Error(`${request.step}: the model declined (${response.stop_details?.category ?? "no category"}).`);
    }
    if (response.stop_reason === "max_tokens") {
      throw new Error(`${request.step}: the response hit the token limit before finishing.`);
    }
    if (response.parsed_output == null) {
      throw new Error(`${request.step}: the response did not match the expected format.`);
    }
    return response.parsed_output;
  }

  /**
   * Lets Claude search the web and write cited notes. Structured output can't be combined with
   * citations, so this returns plain notes and the sources Claude actually cited.
   */
  async research(request: ResearchRequest): Promise<ResearchResult> {
    // The basic tool, because the dynamic-filtering version reads results through code and
    // returns no citations, and every background fact must trace back to a cited passage.
    const tool = { type: "web_search_20250305", name: "web_search", max_uses: request.maxSearches } as const;
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: request.prompt }];
    const blocks: Anthropic.Beta.BetaContentBlock[] = [];

    for (let attempt = 0; ; attempt++) {
      const response = await this.client.beta.messages.create({
        model: this.model,
        max_tokens: 16_000,
        ...(FALLBACK_MODELS.has(this.model)
          ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
          : {}),
        output_config: { effort: this.effort },
        system: request.system,
        tools: [tool],
        messages,
      });
      this.recordUsage(request.step, response.model, response.usage);
      blocks.push(...response.content);

      if (response.stop_reason === "refusal") {
        throw new Error(`${request.step}: the model declined (${response.stop_details?.category ?? "no category"}).`);
      }
      if (response.stop_reason === "max_tokens") {
        throw new Error(`${request.step}: the response hit the token limit before finishing.`);
      }
      if (response.stop_reason !== "pause_turn") break;
      if (attempt >= MAX_CONTINUATIONS) throw new Error(`${request.step}: research did not finish.`);
      // Send the paused turn back unchanged so the server resumes it.
      messages.push({ role: "assistant", content: response.content });
    }
    return collectCitations(blocks);
  }

  private recordUsage(step: string, model: string, usage: Usage): void {
    const price = PRICES[model] ?? PRICES[this.model];
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const cacheWrite = usage.cache_creation_input_tokens ?? 0;
    const searches = usage.server_tool_use?.web_search_requests ?? 0;
    // Cache reads bill at about 0.1x input and cache writes at about 1.25x.
    const tokenCost = price
      ? (usage.input_tokens * price.input +
          cacheRead * price.input * 0.1 +
          cacheWrite * price.input * 1.25 +
          usage.output_tokens * price.output) /
        1_000_000
      : 0;
    const cost = tokenCost + searches * USD_PER_SEARCH;
    this.totalCost += cost;
    const record: UsageRecord = {
      at: new Date().toISOString(),
      step,
      model,
      effort: this.effort,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      webSearches: searches,
      estimatedCostUsd: Number(cost.toFixed(5)),
    };
    if (this.options.usageLogPath) appendFileSync(this.options.usageLogPath, `${JSON.stringify(record)}\n`);
    this.options.onUsage?.(record);
  }
}

/** Joins text blocks into notes, numbering each cited page once and marking citations as [n]. */
export const collectCitations = (blocks: Anthropic.Beta.BetaContentBlock[]): ResearchResult => {
  const sources = new Map<string, Source>();
  let notes = "";
  for (const block of blocks) {
    if (block.type !== "text") continue;
    const ids = new Set<number>();
    for (const citation of block.citations ?? []) {
      if (citation.type !== "web_search_result_location") continue;
      let source = sources.get(citation.url);
      if (!source) {
        source = { id: sources.size + 1, title: citation.title ?? citation.url, url: citation.url, excerpts: [] };
        sources.set(citation.url, source);
      }
      if (!source.excerpts.includes(citation.cited_text)) source.excerpts.push(citation.cited_text);
      ids.add(source.id);
    }
    notes += block.text + [...ids].map((id) => ` [${id}]`).join("");
  }
  return { notes: notes.trim(), sources: [...sources.values()] };
};

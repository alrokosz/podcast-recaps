import type { z } from "zod";

/**
 * Whatever writes the recap text: the Anthropic API with the user's key, or the user's own
 * Claude Code session through the plugin. The pipeline only talks to this interface, so both
 * produce output in the same validated shapes and go through the same spoiler checks.
 */
export interface RecapWriter {
  /** Recorded with saved summaries and recaps, such as "claude-opus-5-5" or "claude-code". */
  readonly name: string;
  /** Returns output that has already been validated against `request.schema`. */
  generate<Schema extends z.ZodType>(request: GenerateRequest<Schema>): Promise<z.infer<Schema>>;
  /** Searches the web and returns notes whose [n] markers point at cited sources. */
  research(request: ResearchRequest): Promise<ResearchResult>;
}

export interface GenerateRequest<Schema extends z.ZodType> {
  /** Short description of the step, such as "summarize 1.4" or "check 1.5". */
  step: string;
  system: string;
  prompt: string;
  schema: Schema;
  maxTokens?: number;
}

export interface ResearchRequest {
  step: string;
  system: string;
  prompt: string;
  maxSearches: number;
}

export interface Source {
  id: number;
  title: string;
  url: string;
  /** Passages cited from this page. */
  excerpts: string[];
}

export interface ResearchResult {
  /** Notes with [n] markers pointing at `sources`. */
  notes: string;
  sources: Source[];
}

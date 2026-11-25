import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { GenerateRequest, RecapWriter, ResearchRequest, ResearchResult } from "./writer.js";

/** The writer name, and settings model, for recaps written by the user's Claude Code session. */
export const SESSION_WRITER = "claude-code";

/** A claimed packet goes back in the queue if no result arrives within this time. */
const DEFAULT_LEASE_MS = 20 * 60_000;
/** The longest a request for the next packet waits before returning empty. */
export const MAX_WAIT_MS = 60_000;

/**
 * One piece of writing for a Claude Code session to do. The session returns output matching
 * `outputSchema`, and the service validates it with the same schema the API path uses.
 */
export interface Packet {
  id: string;
  jobId: number;
  kind: "generate" | "research";
  /** Such as "summarize 1.4", "brief 1.5", "script 1.5", or "check 1.5". */
  step: string;
  /** Do this step in a separate agent that did not write the text, as an independent review. */
  independent: boolean;
  system: string;
  prompt: string;
  /** JSON Schema for the result. */
  outputSchema: unknown;
  /** Extra directions for the session, such as how to report web sources. */
  instructions: string;
  maxSearches?: number;
  createdAt: string;
  claimedAt?: string;
}

export type SubmitResult = { ok: true } | { ok: false; status: 404 | 422; error: string };

interface Entry {
  packet: Packet;
  validate: (output: unknown) => unknown;
  resolve: (output: unknown) => void;
}

/** Research must come back as notes with [n] markers and the pages they cite. */
const ResearchResultSchema = z
  .object({
    notes: z.string().min(1).describe("Concise notes. Mark each claim with the [n] numbers of the sources that support it."),
    sources: z
      .array(
        z.object({
          id: z.number().int().positive(),
          title: z.string().min(1),
          url: z.url({ protocol: /^https?$/ }),
          excerpts: z
            .array(z.string().min(1))
            .min(1)
            .describe("Short passages copied exactly from the page that support the notes."),
        }),
      )
      .min(1),
  })
  .superRefine(({ notes, sources }, context) => {
    const ids = new Set<number>();
    for (const { id } of sources) {
      if (ids.has(id)) context.addIssue({ code: "custom", message: `Source id ${id} is used twice.` });
      ids.add(id);
    }
    const cited = new Set([...notes.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1])));
    for (const id of cited) {
      if (!ids.has(id)) context.addIssue({ code: "custom", message: `The notes cite [${id}], but no source has that id.` });
    }
    if (!cited.size) context.addIssue({ code: "custom", message: "Mark claims in the notes with [n] source numbers." });
  });

const GENERATE_INSTRUCTIONS =
  "Follow the system and prompt text as written. Return only a JSON value matching outputSchema, with no commentary.";
const RESEARCH_INSTRUCTIONS = `Use web search (and web fetch if needed) for at most maxSearches searches on the references in the prompt.
Return JSON matching outputSchema: notes that mark each claim with [n], and the sources they cite. Each excerpt must be a short passage copied exactly from that page. Never include a source you did not open or search.`;

const describeIssues = (error: unknown): string =>
  error instanceof z.ZodError
    ? error.issues
        .map(({ path, message }) => (path.length ? `${path.join(".")}: ${message}` : message))
        .join("; ")
    : error instanceof Error
      ? error.message
      : String(error);

/**
 * Writing steps waiting for a Claude Code session. Jobs add packets and wait; the plugin claims
 * them through the local API and submits results, which are validated before the job continues.
 * Packets live in memory: after a restart, interrupted jobs rerun and reuse their saved summaries.
 */
export class PacketQueue {
  private readonly entries = new Map<string, Entry>();
  private readonly waiters = new Set<() => void>();

  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly leaseMs = DEFAULT_LEASE_MS,
  ) {}

  /** Adds a packet and resolves with its validated result, or rejects if the job is cancelled. */
  add(
    fields: Omit<Packet, "id" | "createdAt" | "claimedAt">,
    validate: (output: unknown) => unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const packet: Packet = { ...fields, id: randomUUID(), createdAt: this.now().toISOString() };
      const onAbort = () => {
        this.entries.delete(packet.id);
        reject(signal?.reason ?? new Error("Cancelled."));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.entries.set(packet.id, {
        packet,
        validate,
        resolve: (output) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(output);
        },
      });
      for (const wake of this.waiters) wake();
    });
  }

  list(): Packet[] {
    return [...this.entries.values()].map(({ packet }) => packet);
  }

  get(id: string): Packet | undefined {
    return this.entries.get(id)?.packet;
  }

  /** Claims the oldest packet not already claimed by a session, waiting up to `waitMs` for one. */
  async next(waitMs = 0, signal?: AbortSignal): Promise<Packet | undefined> {
    const deadline = Date.now() + Math.min(waitMs, MAX_WAIT_MS);
    for (;;) {
      const packet = this.claim();
      if (packet || Date.now() >= deadline || signal?.aborted) return packet;
      await new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          this.waiters.delete(wake);
          signal?.removeEventListener("abort", wake);
          resolve();
        };
        const timer = setTimeout(wake, deadline - Date.now());
        this.waiters.add(wake);
        signal?.addEventListener("abort", wake, { once: true });
      });
    }
  }

  /** Puts a claimed packet back, for a session that can't finish it. */
  release(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    delete entry.packet.claimedAt;
    for (const wake of this.waiters) wake();
    return true;
  }

  /** Validates a result. Invalid output leaves the packet open, so the session can fix and resubmit. */
  submit(id: string, output: unknown): SubmitResult {
    const entry = this.entries.get(id);
    if (!entry) return { ok: false, status: 404, error: "No open packet with that id. It may be done or cancelled." };
    let valid: unknown;
    try {
      valid = entry.validate(output);
    } catch (error) {
      return { ok: false, status: 422, error: `The result doesn't match outputSchema: ${describeIssues(error)}` };
    }
    this.entries.delete(id);
    entry.resolve(valid);
    return { ok: true };
  }

  private claim(): Packet | undefined {
    const now = this.now().getTime();
    for (const { packet } of this.entries.values()) {
      if (packet.claimedAt && now - Date.parse(packet.claimedAt) < this.leaseMs) continue;
      packet.claimedAt = this.now().toISOString();
      return packet;
    }
    return undefined;
  }
}

/** Writes through the user's Claude Code session: each step becomes a packet the plugin picks up. */
export class SessionWriter implements RecapWriter {
  readonly name = SESSION_WRITER;

  constructor(
    private readonly queue: PacketQueue,
    private readonly jobId: number,
    private readonly options: { signal?: AbortSignal; onWaiting?: (step: string) => void } = {},
  ) {}

  async generate<Schema extends z.ZodType>(request: GenerateRequest<Schema>): Promise<z.infer<Schema>> {
    this.options.onWaiting?.(request.step);
    const output = await this.queue.add(
      {
        jobId: this.jobId,
        kind: "generate",
        step: request.step,
        independent: request.independentReview ?? false,
        system: request.system,
        prompt: request.prompt,
        outputSchema: z.toJSONSchema(request.schema),
        instructions: GENERATE_INSTRUCTIONS,
      },
      (value) => request.schema.parse(value),
      this.options.signal,
    );
    return output as z.infer<Schema>;
  }

  async research(request: ResearchRequest): Promise<ResearchResult> {
    this.options.onWaiting?.(request.step);
    const output = await this.queue.add(
      {
        jobId: this.jobId,
        kind: "research",
        step: request.step,
        independent: false,
        system: request.system,
        prompt: request.prompt,
        outputSchema: z.toJSONSchema(ResearchResultSchema),
        instructions: RESEARCH_INSTRUCTIONS,
        maxSearches: request.maxSearches,
      },
      (value) => ResearchResultSchema.parse(value),
      this.options.signal,
    );
    return output as ResearchResult;
  }
}

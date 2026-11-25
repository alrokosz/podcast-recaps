import { Llm } from "./llm.js";
import { type PreparedRecap, prepareRecap, showDir } from "./pipeline.js";
import { type JobRow, monthStart, type Store } from "./store.js";

export const MONTHLY_CAP_KEY = "monthlyCapUsd";

export interface JobContext {
  log: (message: string) => void;
  signal: AbortSignal;
}

export type JobRunner = (job: JobRow, context: JobContext) => Promise<PreparedRecap>;

export interface WorkerOptions {
  dataDir: string;
  /** Looked up per job, so a key saved while the service runs is picked up. */
  getApiKey: () => Promise<string | undefined>;
  /** Replaces the real pipeline, for tests. */
  runJob?: JobRunner;
  now?: () => Date;
}

export interface BudgetStatus {
  spentThisMonthUsd: number;
  monthlyCapUsd: number | null;
}

/** Runs queued jobs one at a time. The spending cap is checked before each job starts. */
export class Worker {
  private loop: Promise<void> | undefined;
  private current: { job: JobRow; controller: AbortController } | undefined;
  private readonly runJob: JobRunner;
  private readonly now: () => Date;

  constructor(
    private readonly store: Store,
    private readonly options: WorkerOptions,
  ) {
    this.runJob = options.runJob ?? ((job, context) => this.runPipeline(job, context));
    this.now = options.now ?? (() => new Date());
  }

  /** Resumes anything interrupted by a restart, then starts working. */
  start(): void {
    this.store.requeueInterrupted();
    this.kick();
  }

  /** Starts the loop if it isn't already running. */
  kick(): void {
    this.loop ??= this.drain().finally(() => {
      this.loop = undefined;
    });
  }

  /** Resolves once the queue is empty or held by the budget. */
  idle(): Promise<void> {
    return this.loop ?? Promise.resolve();
  }

  get currentJobId(): number | undefined {
    return this.current?.job.id;
  }

  budget(): BudgetStatus {
    const cap = this.store.getSetting(MONTHLY_CAP_KEY);
    return {
      spentThisMonthUsd: this.store.spentSince(monthStart(this.now())),
      monthlyCapUsd: cap === undefined ? null : Number(cap),
    };
  }

  setMonthlyCap(usd: number | null): void {
    this.store.setSetting(MONTHLY_CAP_KEY, usd === null ? null : String(usd));
    this.store.releaseBudgetHolds();
    this.kick();
  }

  /** Cancels a queued job, or stops the running one at its next step. */
  cancel(jobId: number): boolean {
    if (this.current?.job.id === jobId) {
      this.current.controller.abort();
      return true;
    }
    return this.store.cancelJobs({ id: jobId }) > 0;
  }

  cancelBatch(batchId: string): number {
    const cancelled = this.store.cancelJobs({ batchId });
    if (this.current?.job.batchId === batchId) {
      this.current.controller.abort();
      return cancelled + 1;
    }
    return cancelled;
  }

  private async drain(): Promise<void> {
    for (let job = this.store.nextQueuedJob(); job; job = this.store.nextQueuedJob()) {
      const { spentThisMonthUsd, monthlyCapUsd } = this.budget();
      if (monthlyCapUsd !== null && spentThisMonthUsd + job.estimatedCostUsd > monthlyCapUsd) {
        this.holdForBudget(spentThisMonthUsd, monthlyCapUsd);
        return;
      }
      await this.run(job);
    }
  }

  private holdForBudget(spent: number, cap: number): void {
    const message = `Waiting: $${spent.toFixed(2)} of the $${cap.toFixed(2)} monthly cap is spent. Raise the cap to continue.`;
    for (const job of this.store.listJobs({ statuses: ["queued"] })) {
      this.store.updateJob(job.id, { status: "waiting_for_budget", progress: message });
    }
  }

  private async run(job: JobRow): Promise<void> {
    const controller = new AbortController();
    this.current = { job, controller };
    this.store.updateJob(job.id, { status: "running", startedAt: this.now().toISOString(), error: null, progress: "Starting" });
    try {
      const result = await this.runJob(job, {
        signal: controller.signal,
        log: (message) => this.store.updateJob(job.id, { progress: message }),
      });
      this.store.updateJob(job.id, {
        status: "done",
        finishedAt: this.now().toISOString(),
        progress: result.reused ? "Done (reused the saved recap text)" : "Done",
        textPath: result.textPath,
        audioPath: result.audioPath ?? null,
        sourcesPath: result.sourcesPath ?? null,
      });
    } catch (error) {
      const cancelled = controller.signal.aborted;
      this.store.updateJob(job.id, {
        status: cancelled ? "cancelled" : "failed",
        finishedAt: this.now().toISOString(),
        progress: cancelled ? "Cancelled" : "Failed",
        error: cancelled ? null : error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.current = undefined;
    }
  }

  private async runPipeline(job: JobRow, { log, signal }: JobContext): Promise<PreparedRecap> {
    const show = this.store.loadShow(job.showId);
    if (!show) throw new Error("This show was removed.");
    const target = show.episodes.find(({ guid }) => guid === job.episodeGuid);
    if (!target) throw new Error("This episode is no longer in the feed.");
    const apiKey = await this.options.getApiKey();
    if (!apiKey) throw new Error("No Anthropic API key is set. Run: recaps key set");

    const llm = new Llm(job.settings.model, job.settings.effort, {
      apiKey,
      onUsage: (record) => this.store.recordUsage(job.id, record),
    });
    return prepareRecap({
      writer: llm,
      show,
      target,
      workDir: showDir(this.options.dataDir, show.slug),
      settings: job.settings,
      log,
      signal,
    });
  }
}

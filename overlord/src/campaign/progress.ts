import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  analyzeCampaignCoordination,
  type CampaignCoordinationMetrics,
} from "./analysis.js";
import type { CampaignManifest } from "./schema.js";

export interface CampaignProgressEvent {
  at: string;
  campaignId: string;
  status: CampaignManifest["status"] | "error" | "stalled";
  severity: "info" | "warning" | "critical";
  completedSlices: number;
  totalSlices: number;
  activeTasks: number;
  taskCount: number;
  spentUsd: number;
  brainDecisionCount: number;
  /** Decisions the model did not supply, so a healthy count cannot hide a dead brain. */
  brainFallbackCount: number;
  replansUsed: number;
  haltReopensUsed: number;
  coordination: CampaignCoordinationMetrics;
  updatedAt: string;
  error?: string;
}

export interface CampaignProgressReporterOptions {
  filename: string;
  webhookUrl?: string;
  webhookToken?: string;
  fetch?: typeof globalThis.fetch;
  webhookMaxAttempts?: number;
  webhookRetryBaseMs?: number;
  stallMs?: number;
}

export class CampaignProgressReporter {
  private readonly fetchImpl: typeof globalThis.fetch;
  private deliveryTail: Promise<void> = Promise.resolve();
  private lastProgressAt = Date.now();
  private stallReported = false;
  private stallTimer: NodeJS.Timeout | undefined;

  constructor(private readonly options: CampaignProgressReporterOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async report(manifest: CampaignManifest): Promise<void> {
    await this.emit({
      at: new Date().toISOString(),
      campaignId: manifest.id,
      status: manifest.status,
      severity:
        manifest.status === "completed"
          ? "info"
          : manifest.status === "running" || manifest.status === "pending"
            ? "info"
            : "warning",
      completedSlices: manifest.slices.filter((slice) => slice.status === "accepted").length,
      totalSlices: manifest.slices.length,
      activeTasks: manifest.tasks.filter(
        (task) => task.status === "queued" || task.status === "running",
      ).length,
      taskCount: manifest.tasks.length,
      spentUsd: manifest.spentUsdSnapshot,
      brainDecisionCount: manifest.brain.decisions.length,
      brainFallbackCount: manifest.brain.decisions.filter(
        (decision) => decision.source === "fallback",
      ).length,
      replansUsed: manifest.brain.replansUsed,
      haltReopensUsed: manifest.brain.haltReopensUsed,
      coordination: analyzeCampaignCoordination(manifest).metrics,
      updatedAt: manifest.updatedAt,
    });
  }

  async failure(manifest: CampaignManifest, error: unknown): Promise<void> {
    await this.emit({
      at: new Date().toISOString(),
      campaignId: manifest.id,
      status: "error",
      severity: "critical",
      completedSlices: manifest.slices.filter((slice) => slice.status === "accepted").length,
      totalSlices: manifest.slices.length,
      activeTasks: manifest.tasks.filter(
        (task) => task.status === "queued" || task.status === "running",
      ).length,
      taskCount: manifest.tasks.length,
      spentUsd: manifest.spentUsdSnapshot,
      brainDecisionCount: manifest.brain.decisions.length,
      brainFallbackCount: manifest.brain.decisions.filter(
        (decision) => decision.source === "fallback",
      ).length,
      replansUsed: manifest.brain.replansUsed,
      haltReopensUsed: manifest.brain.haltReopensUsed,
      coordination: analyzeCampaignCoordination(manifest).metrics,
      updatedAt: manifest.updatedAt,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  startStallDetection(loadManifest: () => Promise<CampaignManifest>): void {
    if (this.stallTimer !== undefined) return;
    const stallMs = Math.max(10, this.options.stallMs ?? 20 * 60 * 1000);
    this.stallTimer = setInterval(() => {
      if (this.stallReported || Date.now() - this.lastProgressAt < stallMs) return;
      this.stallReported = true;
      void loadManifest()
        .then((manifest) =>
          this.emit(
            {
              at: new Date().toISOString(),
              campaignId: manifest.id,
              status: "stalled",
              severity: "critical",
              completedSlices: manifest.slices.filter(
                (slice) => slice.status === "accepted",
              ).length,
              totalSlices: manifest.slices.length,
              activeTasks: manifest.tasks.filter(
                (task) => task.status === "queued" || task.status === "running",
              ).length,
              taskCount: manifest.tasks.length,
              spentUsd: manifest.spentUsdSnapshot,
              brainDecisionCount: manifest.brain.decisions.length,
              brainFallbackCount: manifest.brain.decisions.filter(
                (decision) => decision.source === "fallback",
              ).length,
              replansUsed: manifest.brain.replansUsed,
              haltReopensUsed: manifest.brain.haltReopensUsed,
              coordination: analyzeCampaignCoordination(manifest).metrics,
              updatedAt: manifest.updatedAt,
              error: `No manifest progress for ${stallMs}ms.`,
            },
            false,
          ),
        )
        .catch((error: unknown) => {
          console.error(
            `campaign stall detector failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
    }, Math.max(10, Math.min(60_000, Math.floor(stallMs / 3))));
    this.stallTimer.unref();
  }

  stopStallDetection(): void {
    if (this.stallTimer !== undefined) clearInterval(this.stallTimer);
    this.stallTimer = undefined;
  }

  async flush(): Promise<void> {
    await this.deliveryTail;
  }

  private async emit(event: CampaignProgressEvent, progress = true): Promise<void> {
    await mkdir(path.dirname(this.options.filename), { recursive: true });
    await appendFile(this.options.filename, `${JSON.stringify(event)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    if (progress) {
      this.lastProgressAt = Date.now();
      this.stallReported = false;
    }
    if (!this.options.webhookUrl) return;
    this.deliveryTail = this.deliveryTail
      .then(() => this.deliver(event))
      .catch((error: unknown) => {
        console.error(
          `campaign progress delivery failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }

  private async deliver(event: CampaignProgressEvent): Promise<void> {
    const attempts = Math.max(1, Math.floor(this.options.webhookMaxAttempts ?? 3));
    const retryBaseMs = Math.max(10, this.options.webhookRetryBaseMs ?? 500);
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const headers = new Headers({ "content-type": "application/json" });
      if (this.options.webhookToken) {
        headers.set("authorization", `Bearer ${this.options.webhookToken}`);
      }
      try {
        const response = await this.fetchImpl(this.options.webhookUrl!, {
          method: "POST",
          headers,
          body: JSON.stringify(event),
          signal: AbortSignal.timeout(10_000),
        });
        if (response.ok) return;
        if (response.status !== 429 && response.status < 500) {
          console.error(`campaign progress webhook returned HTTP ${response.status}`);
          return;
        }
      } catch (error) {
        if (attempt === attempts) throw error;
      }
      if (attempt < attempts) {
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(10_000, retryBaseMs * 2 ** (attempt - 1))),
        );
      }
    }
    console.error(`campaign progress webhook exhausted ${attempts} attempt(s)`);
  }
}

export function progressReporterFromEnv(
  campaignDirectory: string,
  env: NodeJS.ProcessEnv = process.env,
): CampaignProgressReporter {
  return new CampaignProgressReporter({
    filename: path.join(campaignDirectory, "progress.jsonl"),
    ...(env["CAMPAIGN_PROGRESS_WEBHOOK_URL"]?.trim()
      ? { webhookUrl: env["CAMPAIGN_PROGRESS_WEBHOOK_URL"]?.trim() }
      : {}),
    ...(env["CAMPAIGN_PROGRESS_WEBHOOK_TOKEN"]?.trim()
      ? { webhookToken: env["CAMPAIGN_PROGRESS_WEBHOOK_TOKEN"]?.trim() }
      : {}),
    webhookMaxAttempts:
      Number.parseInt(env["CAMPAIGN_PROGRESS_WEBHOOK_MAX_ATTEMPTS"] ?? "", 10) || 3,
    webhookRetryBaseMs:
      Number.parseInt(env["CAMPAIGN_PROGRESS_WEBHOOK_RETRY_MS"] ?? "", 10) || 500,
    stallMs:
      Number.parseInt(env["CAMPAIGN_STALL_MS"] ?? "", 10) || 20 * 60 * 1000,
  });
}

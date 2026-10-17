export interface MonitorItemInput {
  platform: string;
  sourceId: string;
  url: string;
  author: string | null;
  text: string;
  createdAt: string | null;
  query: string;
  raw?: unknown;
}

export interface MonitorItem extends MonitorItemInput {
  id: number;
  recipeId: string;
  capturedAt: string;
}

export type MonitorRunStatus = "success" | "empty" | "failed" | "blocked";

export interface MonitorRun {
  id: string;
  recipeId: string;
  query: string;
  startedAt: string;
  finishedAt: string;
  status: MonitorRunStatus;
  seenCount: number;
  insertedCount: number;
  error: string | null;
  browserElapsedMs: number;
  agentUsed: boolean;
  agentCostUsd: number;
}

export interface RecipeHealth {
  recipeId: string;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  consecutiveEmpty: number;
  consecutiveFailures: number;
  lastRepairAt: string | null;
}

export interface MonitorItemQuery {
  since?: string;
  platform?: string;
  query?: string;
  limit?: number;
}

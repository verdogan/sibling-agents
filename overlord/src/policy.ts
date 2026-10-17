export interface SpawnPolicy {
  allowedTools: readonly string[];
  /** Empty/undefined keeps legacy unrestricted routing for that dimension. */
  allowedProviders?: readonly string[];
  allowedModels?: readonly string[];
  allowedSkills?: readonly string[];
  allowInlineSkills?: boolean;
  maxCostUsdPerTask: number;
  maxTurnsPerTask: number;
  maxWallClockMsPerTask: number;
  maxTasksPerRun: number;
  maxConcurrentTasks: number;
  maxTotalCostUsd: number;
}

export interface SpawnPolicyRequest {
  tools?: readonly string[];
  max_cost_usd?: number;
  max_turns?: number;
  max_wall_clock_ms?: number;
}

export interface AppliedSpawnPolicy {
  tools: string[];
  maxCostUsd: number;
  maxTurns: number;
  maxWallClockMs: number;
  trimmed: boolean;
}

export interface ProfileCapabilityRequest {
  provider?: string;
  model?: string;
  skills?: readonly string[];
  inlineSkillCount?: number;
}

export const DEFAULT_ALLOWED_TOOLS = [
  "read",
  "write",
  "edit",
  "ls",
  "grep",
  "find",
  "bash",
  "http_request",
  "write_result",
  "record_finding",
  "verify_finding",
  "declare_intent",
  "campaign_send",
  "agent_browser",
  "browser_open",
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_extract",
  "browser_wait_for",
  "browser_screenshot",
  // Oversight (reports/oversight-wire.md). Allowed is not granted: a task gets
  // these only as half of a watched pair, whose condition picks them.
  "ask_overseer",
  "tell_principal",
  "watch_next",
  "advise",
  "caution",
  "hold",
  "release",
  "report_concern",
] as const;

export const DEFAULT_SPAWN_POLICY: SpawnPolicy = {
  allowedTools: DEFAULT_ALLOWED_TOOLS,
  maxCostUsdPerTask: 2,
  maxTurnsPerTask: 40,
  maxWallClockMsPerTask: 900_000,
  maxTasksPerRun: 8,
  maxConcurrentTasks: 2,
  maxTotalCostUsd: 10,
};

function positive(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number.`);
  }
  return value;
}

function envNumber(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function envList(env: NodeJS.ProcessEnv, name: string): string[] | undefined {
  const values = env[name]
    ?.split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");
  return values === undefined || values.length === 0 ? undefined : [...new Set(values)];
}

function envBoolean(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
}

export function spawnPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): SpawnPolicy {
  const configuredTools = env["FLEET_ALLOWED_TOOLS"]
    ?.split(",")
    .map((tool) => tool.trim())
    .filter((tool) => tool !== "");

  return {
    allowedTools:
      configuredTools === undefined || configuredTools.length === 0
        ? DEFAULT_ALLOWED_TOOLS
        : [...new Set(configuredTools)],
    ...(envList(env, "FLEET_ALLOWED_PROVIDERS") === undefined
      ? {}
      : { allowedProviders: envList(env, "FLEET_ALLOWED_PROVIDERS") }),
    ...(envList(env, "FLEET_ALLOWED_MODELS") === undefined
      ? {}
      : { allowedModels: envList(env, "FLEET_ALLOWED_MODELS") }),
    ...(envList(env, "FLEET_ALLOWED_SKILLS") === undefined
      ? {}
      : { allowedSkills: envList(env, "FLEET_ALLOWED_SKILLS") }),
    allowInlineSkills: envBoolean(env, "FLEET_ALLOW_INLINE_SKILLS", false),
    maxCostUsdPerTask: DEFAULT_SPAWN_POLICY.maxCostUsdPerTask,
    maxTurnsPerTask: DEFAULT_SPAWN_POLICY.maxTurnsPerTask,
    maxWallClockMsPerTask: DEFAULT_SPAWN_POLICY.maxWallClockMsPerTask,
    maxTasksPerRun: Math.floor(
      envNumber(env, "FLEET_MAX_TASKS", DEFAULT_SPAWN_POLICY.maxTasksPerRun),
    ),
    maxConcurrentTasks: Math.floor(
      envNumber(env, "FLEET_MAX_CONCURRENT", DEFAULT_SPAWN_POLICY.maxConcurrentTasks),
    ),
    maxTotalCostUsd: envNumber(
      env,
      "FLEET_MAX_TOTAL_COST_USD",
      DEFAULT_SPAWN_POLICY.maxTotalCostUsd,
    ),
  };
}

/** Return a human-readable hard-policy refusal; capability fields are never silently trimmed. */
export function profileCapabilityViolation(
  request: ProfileCapabilityRequest,
  policy: SpawnPolicy,
): string | undefined {
  if (
    request.provider !== undefined &&
    policy.allowedProviders !== undefined &&
    !policy.allowedProviders.includes(request.provider)
  ) {
    return `provider ${JSON.stringify(request.provider)} is not allowed`;
  }
  if (
    request.model !== undefined &&
    policy.allowedModels !== undefined &&
    !policy.allowedModels.includes(request.model)
  ) {
    return `model ${JSON.stringify(request.model)} is not allowed`;
  }
  const disallowedSkills =
    request.skills?.filter(
      (skill) => policy.allowedSkills !== undefined && !policy.allowedSkills.includes(skill),
    ) ?? [];
  if (disallowedSkills.length > 0) {
    return `skill(s) ${disallowedSkills.map((skill) => JSON.stringify(skill)).join(", ")} are not allowed`;
  }
  if ((request.inlineSkillCount ?? 0) > 0 && policy.allowInlineSkills !== true) {
    return "inline skills are not allowed";
  }
  return undefined;
}

export function applySpawnPolicy(
  request: SpawnPolicyRequest,
  policy: SpawnPolicy,
): AppliedSpawnPolicy {
  const requestedTools = request.tools ?? policy.allowedTools;
  const allowed = new Set(policy.allowedTools);
  const tools = [...new Set(requestedTools.filter((tool) => allowed.has(tool)))];

  const requestedCost = positive(
    request.max_cost_usd,
    policy.maxCostUsdPerTask,
    "max_cost_usd",
  );
  const requestedTurns = positive(request.max_turns, policy.maxTurnsPerTask, "max_turns");
  const requestedWallClock = positive(
    request.max_wall_clock_ms,
    policy.maxWallClockMsPerTask,
    "max_wall_clock_ms",
  );

  const maxCostUsd = Math.min(requestedCost, policy.maxCostUsdPerTask);
  const maxTurns = Math.min(Math.floor(requestedTurns), Math.floor(policy.maxTurnsPerTask));
  const maxWallClockMs = Math.min(
    Math.floor(requestedWallClock),
    Math.floor(policy.maxWallClockMsPerTask),
  );
  if (maxTurns <= 0 || maxWallClockMs <= 0) {
    throw new RangeError("Turn and wall-clock budgets must remain positive after rounding.");
  }

  return {
    tools,
    maxCostUsd,
    maxTurns,
    maxWallClockMs,
    trimmed:
      tools.length !== requestedTools.length ||
      maxCostUsd !== requestedCost ||
      maxTurns !== requestedTurns ||
      maxWallClockMs !== requestedWallClock,
  };
}

import type { LingInlineSkill } from "../ling/types.js";
import {
  resolvedProfileHash,
  type ProfileLibrary,
  type ResolvedProfile,
} from "../profiles/index.js";
import type { CampaignArtifactStore } from "./artifacts.js";
import type { CampaignManifestStore } from "./manifest.js";
import { OVERSIGHT_LIMITS, workerOversightTools, type WatchCondition } from "./oversight.js";
import {
  CAMPAIGN_VERSION,
  parseCampaignManifest,
  type AcceptanceCriterion,
  type CampaignBrainState,
  type CampaignBudget,
  type CampaignCoordination,
  type CampaignManifest,
  type CampaignRoleProfiles,
  type CampaignWatchConfig,
  type CampaignWorkRole,
  type ReferenceBar,
  type RoleProfile,
} from "./schema.js";

export interface CampaignSliceDefinition {
  id: string;
  spec: string;
  /** Slice ids whose accepted output this slice needs. Omit to seed them all. */
  dependsOn?: string[];
}

export interface CampaignArtifactBarDefinition {
  kind: "artifact";
  /** Human name used only in the operator definition. */
  ref: string;
  appliesTo: string[];
  content: string;
}

export interface CampaignDefinition {
  id: string;
  goal: string;
  acceptance: AcceptanceCriterion[];
  budget: CampaignBudget;
  slices?: CampaignSliceDefinition[];
  allowPlanning?: boolean;
  bar?: ReferenceBar | CampaignArtifactBarDefinition | null;
  maxRounds?: number;
  roles?: Record<CampaignWorkRole, RoleProfile | string>;
  brain?: Partial<
    Pick<CampaignBrainState, "enabled" | "maxDecisions" | "maxHaltReopens">
  >;
  coordination?: Partial<
    Pick<
      CampaignCoordination,
      | "enabled"
      | "planningCandidates"
      | "parallelSlices"
      | "passiveMessaging"
      | "maxMessages"
      | "maxMessageBytes"
    >
  > & { watch?: CampaignWatchDefinition };
}

/** How an operator asks for watched builders. Unset fields take the contract's defaults. */
export interface CampaignWatchDefinition {
  /** Default true: a builder whose watcher does not start is never spawned. */
  required?: boolean;
  condition: WatchCondition;
  /** Required unless the condition is no_watcher. */
  watcher?: CampaignWatchConfig["watcher"];
  /** Default 0.75, reserved together with the builder's ceiling. */
  watcherMaxCostUsd?: number;
  watchFor?: string;
  /**
   * Unset is the standard worker prompt. A variant runs under one condition
   * only, and a draft one only in a dry run (WORKER_VARIANTS). Stored only
   * when set, as is dryRun. One whose text says what the run keeps runs only
   * on a client with release() and terminate(), as the local-task one has. No
   * definition shows the client, so the driver refuses it on any other when
   * the campaign starts (its LEASE_ONLY_VARIANTS), not initialize.
   */
  workerVariant?: CampaignWatchConfig["workerVariant"];
  /**
   * Unset is not a dry run. True is admitted only where every role and the
   * watcher are on a scripted model and the brain is off.
   */
  dryRun?: boolean;
}

export interface InitializeCampaignOptions {
  profileLibrary?: ProfileLibrary;
}

export const DEFAULT_CAMPAIGN_COORDINATION: CampaignCoordination = {
  enabled: false,
  planningCandidates: 1,
  parallelSlices: false,
  passiveMessaging: false,
  maxMessages: 64,
  maxMessageBytes: 4096,
  decisions: [],
  messages: [],
};

export const DEFAULT_CAMPAIGN_BRAIN: CampaignBrainState = {
  enabled: false,
  maxDecisions: 32,
  maxHaltReopens: 1,
  replansUsed: 0,
  haltReopensUsed: 0,
  pendingRecovery: null,
  decisions: [],
};

/**
 * The web tools every default role gets. None of them runs model-authored code in the
 * Ling service process; the raw-Playwright tool that did was removed, not left un-defaulted.
 */
const RESEARCH_TOOLS = [
  "http_request",
  "agent_browser",
  "browser_open",
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_extract",
  "browser_wait_for",
  "browser_screenshot",
];

// The recording and verification tools are granted by default rather than only to
// campaigns declared as research. A slice that turns out to need a fact about the
// world is discovered mid-campaign, and a builder that cannot record evidence at
// that point simply asserts things instead. Granting both costs a prompt section
// on tasks that never call them; withholding them costs the evidence chain.
// Declaring intent is granted to every role for the same reason, and one more:
// the comparison it feeds treats a role without the tool as a recorded opt-out.
// Withholding it by default would report every campaign as inapplicable, which
// is the shape of a check that silently never runs.
const BUILD_TOOLS = [
  "read",
  "write",
  "edit",
  "ls",
  "grep",
  "find",
  "bash",
  ...RESEARCH_TOOLS,
  "record_finding",
  "declare_intent",
];
const REVIEW_TOOLS = [
  "read",
  "ls",
  "grep",
  "find",
  "bash",
  ...RESEARCH_TOOLS,
  "write_result",
  "verify_finding",
  "declare_intent",
];

export const DEFAULT_CAMPAIGN_ROLES: CampaignRoleProfiles = {
  planner: {
    tools: [...BUILD_TOOLS],
    maxCostUsd: 0.5,
    maxTurns: 12,
    maxWallClockMs: 300_000,
  },
  builder: {
    tools: [...BUILD_TOOLS],
    maxCostUsd: 0.75,
    maxTurns: 24,
    maxWallClockMs: 600_000,
  },
  reviewer: {
    tools: [...REVIEW_TOOLS],
    maxCostUsd: 0.5,
    maxTurns: 16,
    maxWallClockMs: 300_000,
  },
  integration: {
    tools: [...REVIEW_TOOLS],
    maxCostUsd: 0.75,
    maxTurns: 20,
    maxWallClockMs: 420_000,
  },
};

function object(value: unknown, location: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${location} must be an object.`);
  }
  return value as Record<string, unknown>;
}

const CAMPAIGN_ROLES = ["planner", "builder", "reviewer", "integration"] as const;

function parseRoleDefinitions(
  value: unknown,
): Record<CampaignWorkRole, RoleProfile | string> {
  const raw = object(value, "Campaign definition roles");
  const unknown = Object.keys(raw).filter(
    (key) => !CAMPAIGN_ROLES.includes(key as CampaignWorkRole),
  );
  const missing = CAMPAIGN_ROLES.filter((role) => !Object.hasOwn(raw, role));
  if (unknown.length > 0 || missing.length > 0) {
    throw new TypeError(
      `Campaign definition roles must contain exactly planner, builder, reviewer, integration` +
        `${unknown.length === 0 ? "" : `; unknown: ${unknown.join(", ")}`}` +
        `${missing.length === 0 ? "" : `; missing: ${missing.join(", ")}`}.`,
    );
  }
  return Object.fromEntries(
    CAMPAIGN_ROLES.map((role) => {
      const entry = raw[role];
      if (typeof entry === "string") {
        if (entry.trim() === "") {
          throw new TypeError(`Campaign definition roles.${role} profile name must not be empty.`);
        }
        return [role, entry];
      }
      return [role, object(entry, `Campaign definition roles.${role}`) as unknown as RoleProfile];
    }),
  ) as unknown as Record<CampaignWorkRole, RoleProfile | string>;
}

function parseDefinition(value: unknown): CampaignDefinition {
  const raw = object(value, "Campaign definition");
  const allowed = new Set([
    "id",
    "goal",
    "acceptance",
    "budget",
    "slices",
    "allowPlanning",
    "bar",
    "maxRounds",
    "roles",
    "brain",
    "coordination",
  ]);
  const unknown = Object.keys(raw).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new TypeError(`Campaign definition has unknown field(s): ${unknown.join(", ")}.`);
  }
  if (
    typeof raw["id"] !== "string" ||
    raw["id"].trim() === "" ||
    Buffer.byteLength(raw["id"], "utf8") > 64
  ) {
    throw new TypeError(
      "Campaign definition id must be a non-empty string of at most 64 UTF-8 bytes.",
    );
  }
  if (!Array.isArray(raw["slices"]) && raw["slices"] !== undefined) {
    throw new TypeError("Campaign definition slices must be an array.");
  }
  const slices = (raw["slices"] ?? []).map((item: unknown, index: number) => {
    const slice = object(item, `Campaign definition slices[${index}]`);
    const allowedSliceKeys = new Set(["id", "spec", "dependsOn"]);
    const sliceUnknown = Object.keys(slice).filter((key) => !allowedSliceKeys.has(key));
    if (sliceUnknown.length > 0) {
      throw new TypeError(
        `Campaign definition slices[${index}] has unknown field(s): ${sliceUnknown.join(", ")}.`,
      );
    }
    if (
      typeof slice["id"] !== "string" ||
      slice["id"].trim() === "" ||
      Buffer.byteLength(slice["id"], "utf8") > 64
    ) {
      throw new TypeError(
        `Campaign definition slices[${index}].id must be a non-empty string of at most 64 UTF-8 bytes.`,
      );
    }
    if (typeof slice["spec"] !== "string" || slice["spec"].trim() === "") {
      throw new TypeError(`Campaign definition slices[${index}].spec must be non-empty text.`);
    }
    const dependsOn = slice["dependsOn"];
    if (dependsOn !== undefined) {
      if (
        !Array.isArray(dependsOn) ||
        dependsOn.some((id) => typeof id !== "string" || id.trim() === "")
      ) {
        throw new TypeError(
          `Campaign definition slices[${index}].dependsOn must be an array of slice ids.`,
        );
      }
    }
    return {
      id: slice["id"],
      spec: slice["spec"],
      ...(dependsOn === undefined ? {} : { dependsOn: dependsOn as string[] }),
    };
  });
  let coordination: CampaignDefinition["coordination"];
  if (raw["coordination"] !== undefined) {
    const value = object(raw["coordination"], "Campaign definition coordination");
    const allowedCoordinationKeys = new Set([
      "enabled",
      "planningCandidates",
      "parallelSlices",
      "passiveMessaging",
      "maxMessages",
      "maxMessageBytes",
      "watch",
    ]);
    const coordinationUnknown = Object.keys(value).filter(
      (key) => !allowedCoordinationKeys.has(key),
    );
    if (coordinationUnknown.length > 0) {
      throw new TypeError(
        `Campaign definition coordination has unknown field(s): ${coordinationUnknown.join(", ")}.`,
      );
    }
    for (const key of ["enabled", "parallelSlices", "passiveMessaging"] as const) {
      if (value[key] !== undefined && typeof value[key] !== "boolean") {
        throw new TypeError(`Campaign definition coordination.${key} must be a boolean.`);
      }
    }
    for (const key of [
      "planningCandidates",
      "maxMessages",
      "maxMessageBytes",
    ] as const) {
      if (
        value[key] !== undefined &&
        (typeof value[key] !== "number" ||
          !Number.isSafeInteger(value[key]) ||
          (value[key] as number) <= 0)
      ) {
        throw new TypeError(
          `Campaign definition coordination.${key} must be a positive safe integer.`,
        );
      }
    }
    // A watch is only seen to be an object here. parseCampaignManifest is the
    // one place it is validated, once initializeCampaign has filled in its defaults.
    if (value["watch"] !== undefined) {
      object(value["watch"], "Campaign definition coordination.watch");
    }
    coordination = value as CampaignDefinition["coordination"];
  }
  let brain: CampaignDefinition["brain"];
  if (raw["brain"] !== undefined) {
    const value = object(raw["brain"], "Campaign definition brain");
    const allowedBrainKeys = new Set(["enabled", "maxDecisions", "maxHaltReopens"]);
    const brainUnknown = Object.keys(value).filter((key) => !allowedBrainKeys.has(key));
    if (brainUnknown.length > 0) {
      throw new TypeError(
        `Campaign definition brain has unknown field(s): ${brainUnknown.join(", ")}.`,
      );
    }
    if (value["enabled"] !== undefined && typeof value["enabled"] !== "boolean") {
      throw new TypeError("Campaign definition brain.enabled must be a boolean.");
    }
    for (const key of ["maxDecisions", "maxHaltReopens"] as const) {
      if (
        value[key] !== undefined &&
        (typeof value[key] !== "number" ||
          !Number.isSafeInteger(value[key]) ||
          (key === "maxDecisions" ? value[key] <= 0 : value[key] < 0))
      ) {
        throw new TypeError(
          `Campaign definition brain.${key} must be a ${key === "maxDecisions" ? "positive" : "non-negative"} safe integer.`,
        );
      }
    }
    brain = value as CampaignDefinition["brain"];
  }
  return {
    id: raw["id"] as string,
    goal: raw["goal"] as string,
    acceptance: raw["acceptance"] as AcceptanceCriterion[],
    budget: raw["budget"] as CampaignBudget,
    slices,
    ...(raw["allowPlanning"] === undefined
      ? {}
      : { allowPlanning: raw["allowPlanning"] as boolean }),
    ...(raw["bar"] === undefined
      ? {}
      : { bar: raw["bar"] as ReferenceBar | CampaignArtifactBarDefinition | null }),
    ...(raw["maxRounds"] === undefined ? {} : { maxRounds: raw["maxRounds"] as number }),
    ...(raw["roles"] === undefined ? {} : { roles: parseRoleDefinitions(raw["roles"]) }),
    ...(brain === undefined ? {} : { brain }),
    ...(coordination === undefined ? {} : { coordination }),
  };
}

/**
 * The watch configuration a manifest stores: the definition as given, with
 * the contract's defaults filled in (§11.1). Nothing is validated here, and
 * an unknown field is kept so that it is refused. A default replaces only an
 * absent field, so an explicit null required or cost reaches the schema and
 * is refused there; a null watcher has always meant none.
 * parseCampaignManifest, which initializeCampaign always runs on the result,
 * is the one place a watch is checked, and validatePairs there refuses what
 * v1 cannot pair.
 */
function watchWithDefaults(definition: CampaignWatchDefinition): CampaignWatchConfig {
  return {
    ...definition,
    required: definition.required === undefined ? true : definition.required,
    watcher: definition.watcher ?? null,
    watcherMaxCostUsd:
      definition.watcherMaxCostUsd === undefined
        ? OVERSIGHT_LIMITS.defaultWatcherMaxCostUsd
        : definition.watcherMaxCostUsd,
  };
}

function resolvedProfileToRoleProfile(
  name: string,
  profile: ResolvedProfile,
  fallback: RoleProfile,
  catalogueVersion: number,
): RoleProfile {
  if (profile.tools.length === 0) {
    throw new TypeError(`Resolved profile ${JSON.stringify(name)} must select at least one tool.`);
  }
  const files = Object.fromEntries(
    profile.seedFiles.map((file) => [file.path, file.content]),
  );
  const inlineSkills: LingInlineSkill[] = profile.inlineSkills.map((skill) => ({
    name: skill.name,
    content: skill.content,
  }));
  return {
    tools: [...profile.tools],
    maxCostUsd: profile.maxCostUsd ?? fallback.maxCostUsd,
    maxTurns: profile.maxTurns ?? fallback.maxTurns,
    maxWallClockMs: profile.maxWallClockMs ?? fallback.maxWallClockMs,
    ...(profile.provider === undefined ? {} : { provider: profile.provider }),
    ...(profile.model === undefined ? {} : { model: profile.model }),
    ...(profile.thinking === undefined ? {} : { thinking: profile.thinking }),
    ...(profile.namedSkills.length === 0 ? {} : { skills: [...profile.namedSkills] }),
    ...(inlineSkills.length === 0 ? {} : { inlineSkills }),
    ...(profile.instructions === undefined ? {} : { instructions: profile.instructions }),
    ...(Object.keys(files).length === 0 ? {} : { files }),
    sourceProfile: {
      name,
      catalogueVersion,
      sha256: resolvedProfileHash(profile),
    },
  };
}

function resolveRoleProfiles(
  definitions: CampaignDefinition["roles"],
  profileLibrary: ProfileLibrary | undefined,
): CampaignRoleProfiles {
  if (definitions === undefined) return structuredClone(DEFAULT_CAMPAIGN_ROLES);
  return Object.fromEntries(
    CAMPAIGN_ROLES.map((role) => {
      const definition = definitions[role];
      if (typeof definition !== "string") return [role, structuredClone(definition)];
      if (profileLibrary === undefined) {
        throw new TypeError(
          `Campaign role ${role} references profile ${JSON.stringify(definition)}, ` +
            "but no profile library was supplied.",
        );
      }
      return [
        role,
        resolvedProfileToRoleProfile(
          definition,
          profileLibrary.resolveProfile(definition),
          DEFAULT_CAMPAIGN_ROLES[role],
          profileLibrary.catalogue.version,
        ),
      ];
    }),
  ) as CampaignRoleProfiles;
}

export async function initializeCampaign(
  store: CampaignManifestStore,
  artifacts: CampaignArtifactStore,
  input: unknown,
  options: InitializeCampaignOptions = {},
): Promise<CampaignManifest> {
  const definition = parseDefinition(input);
  const suppliedSlices = definition.slices ?? [];
  const sliceRecords = [];
  for (const [index, slice] of suppliedSlices.entries()) {
    const spec = await artifacts.storeText(`specs/${index + 1}`, "spec.md", slice.spec);
    sliceRecords.push({
      id: slice.id,
      spec,
      status: "pending" as const,
      attempts: [],
      createdInRound: 0,
      ...(slice.dependsOn === undefined ? {} : { dependsOn: slice.dependsOn }),
    });
  }
  let bar: ReferenceBar | null = definition.bar ?? null;
  if (bar !== null && bar.kind === "artifact" && "content" in bar) {
    const unknownBarFields = Object.keys(bar).filter(
      (key) => !["kind", "ref", "appliesTo", "content"].includes(key),
    );
    if (unknownBarFields.length > 0) {
      throw new TypeError(
        `Artifact reference bar has unknown field(s): ${unknownBarFields.join(", ")}.`,
      );
    }
    if (typeof bar.ref !== "string" || bar.ref.trim() === "") {
      throw new TypeError("Artifact reference bar ref must name the reference.");
    }
    if (typeof bar.content !== "string" || bar.content.trim() === "") {
      throw new TypeError("Artifact reference bar content must be non-empty text.");
    }
    const stored = await artifacts.storeText("bars/1", "reference.txt", bar.content);
    bar = { kind: "artifact", ref: stored.path, appliesTo: bar.appliesTo };
  }
  const now = new Date().toISOString();
  const { watch: watchDefinition, ...coordinationDefinition } = definition.coordination ?? {};
  const coordination: CampaignCoordination = {
    ...structuredClone(DEFAULT_CAMPAIGN_COORDINATION),
    ...coordinationDefinition,
    decisions: [],
    messages: [],
  };
  const brain: CampaignBrainState = {
    ...structuredClone(DEFAULT_CAMPAIGN_BRAIN),
    ...(definition.brain ?? {}),
    replansUsed: 0,
    haltReopensUsed: 0,
    pendingRecovery: null,
    decisions: [],
  };
  if (!coordination.enabled) {
    coordination.planningCandidates = 1;
    coordination.parallelSlices = false;
    coordination.passiveMessaging = false;
  }
  if (coordination.passiveMessaging && !coordination.parallelSlices) {
    throw new TypeError(
      "Campaign passiveMessaging requires parallelSlices so another slice can be listening.",
    );
  }
  if (coordination.parallelSlices && definition.budget.maxTotalTokens !== undefined) {
    throw new TypeError(
      "Campaign parallelSlices cannot use maxTotalTokens until per-task token reservations exist.",
    );
  }
  if (
    coordination.parallelSlices &&
    sliceRecords.some((slice) => slice.dependsOn === undefined)
  ) {
    throw new TypeError(
      "Campaign parallelSlices requires every supplied slice to declare dependsOn explicitly.",
    );
  }
  const roleProfiles = resolveRoleProfiles(definition.roles, options.profileLibrary);
  if (coordination.passiveMessaging) {
    for (const role of ["builder", "reviewer"] as const) {
      if (!roleProfiles[role].tools.includes("campaign_send")) {
        roleProfiles[role].tools.push("campaign_send");
      }
    }
  }
  if (watchDefinition !== undefined) {
    coordination.watch = watchWithDefaults(watchDefinition);
    // The builder's profile carries the condition's own oversight tools. A
    // builder whose optional watcher did not start loses ask_overseer at spawn.
    for (const tool of workerOversightTools(coordination.watch.condition)) {
      if (!roleProfiles.builder.tools.includes(tool)) roleProfiles.builder.tools.push(tool);
    }
  }
  const candidate = parseCampaignManifest({
    version: CAMPAIGN_VERSION,
    id: definition.id,
    goal: definition.goal,
    status: "pending",
    acceptance: definition.acceptance,
    bar,
    allowPlanning: definition.allowPlanning ?? false,
    maxRounds: definition.maxRounds ?? 3,
    currentSliceId: sliceRecords[0]?.id ?? null,
    slices: sliceRecords,
    planning: {
      status: sliceRecords.length > 0 ? "not_required" : "pending",
      taskId: null,
      candidateTaskIds: [],
      candidateArtifacts: [],
      artifacts: [],
      evidence: [],
      gaps: [],
    },
    integration: {
      reviewerId: null,
      verdict: null,
      evidence: [],
      gaps: [],
      attempts: [],
    },
    coordination,
    brain,
    budget: definition.budget,
    roles: roleProfiles,
    tasks: [],
    summons: [],
    spentUsdSnapshot: 0,
    spentTokensSnapshot: 0,
    updatedAt: now,
  });
  return store.create(candidate);
}

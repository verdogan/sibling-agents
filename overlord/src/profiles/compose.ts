import { PROFILE_INSTRUCTION_SEPARATOR, PROFILE_LIMITS } from "./limits.js";
import {
  parseProfileFragment,
  parseProfileName,
  parseProfileScalarOverrides,
  utf8Bytes,
} from "./schema.js";
import type {
  InlineProfileSkill,
  ProfileFragment,
  ProfileScalarOverrides,
  ProfileThinking,
  ResolvedProfile,
  StaticSeedFile,
} from "./types.js";

export type ProfileCompositionErrorCode =
  | "scalar_conflict"
  | "inline_skill_conflict"
  | "skill_kind_conflict"
  | "seed_collision"
  | "too_many_fragments"
  | "too_many_tools"
  | "too_many_named_skills"
  | "too_many_inline_skills"
  | "too_many_seed_files"
  | "too_many_bytes";

export class ProfileCompositionError extends Error {
  constructor(
    message: string,
    readonly code: ProfileCompositionErrorCode,
  ) {
    super(message);
    this.name = "ProfileCompositionError";
  }
}

export interface NamedProfileFragment {
  readonly name: string;
  readonly fragment: ProfileFragment;
}

type ScalarKey = "provider" | "model" | "thinking";
const SCALAR_KEYS = ["provider", "model", "thinking"] as const;

function compositionFail(code: ProfileCompositionErrorCode, message: string): never {
  throw new ProfileCompositionError(message, code);
}

function portableCollisionKey(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

function freezeInlineSkill(skill: InlineProfileSkill): InlineProfileSkill {
  return Object.freeze({ name: skill.name, content: skill.content });
}

function freezeSeedFile(file: StaticSeedFile): StaticSeedFile {
  return Object.freeze({ path: file.path, content: file.content });
}

/**
 * Composes already named fragments in the supplied order. The names are used
 * only for validation and useful conflict diagnostics; they do not affect the
 * resolved value.
 */
export function composeNamedProfileFragments(
  inputs: readonly NamedProfileFragment[],
  finalOverrides: ProfileScalarOverrides = {},
): ResolvedProfile {
  if (!Array.isArray(inputs)) {
    throw new TypeError("Profile fragments must be an array.");
  }
  if (inputs.length > PROFILE_LIMITS.fragmentReferences) {
    compositionFail(
      "too_many_fragments",
      `A profile may compose at most ${PROFILE_LIMITS.fragmentReferences} fragments.`,
    );
  }

  const fragments = inputs.map((input, index) => {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw new TypeError(`Profile fragment input ${index} must be an object.`);
    }
    const name = parseProfileName(input.name, `fragments[${index}].name`);
    return {
      name,
      fragment: parseProfileFragment(input.fragment, `fragments[${index}].fragment`),
    };
  });
  const overrides = parseProfileScalarOverrides(finalOverrides, "finalOverrides");

  const scalarValues = new Map<ScalarKey, string>();
  const scalarSources = new Map<ScalarKey, Map<string, string[]>>();
  const scalarConflicts = new Set<ScalarKey>();
  const tools: string[] = [];
  const toolSet = new Set<string>();
  const namedSkills: string[] = [];
  const namedSkillSet = new Set<string>();
  const inlineSkills: InlineProfileSkill[] = [];
  const inlineSkillSources = new Map<string, string>();
  const instructions: string[] = [];
  const seedFiles: StaticSeedFile[] = [];
  const seedByPath = new Map<string, { file: StaticSeedFile; source: string }>();
  let instructionBytes = 0;
  let totalInlineSkillBytes = 0;
  let totalSeedBytes = 0;
  let maxCostUsd: number | undefined;
  let maxTurns: number | undefined;
  let maxWallClockMs: number | undefined;

  const addScalar = (key: ScalarKey, value: string, source: string): void => {
    const prior = scalarValues.get(key);
    if (prior === undefined) {
      scalarValues.set(key, value);
    } else if (prior !== value) {
      scalarConflicts.add(key);
    }
    let sources = scalarSources.get(key);
    if (sources === undefined) {
      sources = new Map<string, string[]>();
      scalarSources.set(key, sources);
    }
    const valueSources = sources.get(value);
    if (valueSources === undefined) sources.set(value, [source]);
    else valueSources.push(source);
  };

  const addUnionName = (
    value: string,
    values: string[],
    seen: Set<string>,
    maximum: number,
    code: "too_many_tools" | "too_many_named_skills",
    label: string,
  ): void => {
    if (seen.has(value)) return;
    if (values.length >= maximum) {
      compositionFail(code, `Composed profile exceeds the ${maximum} ${label} limit.`);
    }
    seen.add(value);
    values.push(value);
  };

  for (const { name: source, fragment } of fragments) {
    for (const key of SCALAR_KEYS) {
      const value = fragment[key];
      if (value !== undefined) addScalar(key, value, source);
    }

    for (const tool of fragment.tools ?? []) {
      addUnionName(
        tool,
        tools,
        toolSet,
        PROFILE_LIMITS.tools,
        "too_many_tools",
        "tool",
      );
    }

    for (const skill of fragment.namedSkills ?? []) {
      if (inlineSkillSources.has(skill)) {
        compositionFail(
          "skill_kind_conflict",
          `Named skill ${JSON.stringify(skill)} from ${JSON.stringify(source)} conflicts with an inline skill of the same name.`,
        );
      }
      addUnionName(
        skill,
        namedSkills,
        namedSkillSet,
        PROFILE_LIMITS.namedSkills,
        "too_many_named_skills",
        "named skill",
      );
    }

    for (const skill of fragment.inlineSkills ?? []) {
      const priorSource = inlineSkillSources.get(skill.name);
      if (priorSource !== undefined) {
        compositionFail(
          "inline_skill_conflict",
          `Inline skill ${JSON.stringify(skill.name)} from ${JSON.stringify(source)} duplicates its definition from ${JSON.stringify(priorSource)}.`,
        );
      }
      if (namedSkillSet.has(skill.name)) {
        compositionFail(
          "skill_kind_conflict",
          `Inline skill ${JSON.stringify(skill.name)} from ${JSON.stringify(source)} conflicts with a named skill of the same name.`,
        );
      }
      if (inlineSkills.length >= PROFILE_LIMITS.inlineSkills) {
        compositionFail(
          "too_many_inline_skills",
          `Composed profile exceeds the ${PROFILE_LIMITS.inlineSkills} inline skill limit.`,
        );
      }
      totalInlineSkillBytes += utf8Bytes(skill.content);
      if (totalInlineSkillBytes > PROFILE_LIMITS.totalInlineSkillBytes) {
        compositionFail(
          "too_many_bytes",
          `Composed inline skill content exceeds ${PROFILE_LIMITS.totalInlineSkillBytes} UTF-8 bytes.`,
        );
      }
      inlineSkillSources.set(skill.name, source);
      inlineSkills.push(skill);
    }

    if (fragment.instructions !== undefined) {
      const separatorBytes =
        instructions.length === 0 ? 0 : utf8Bytes(PROFILE_INSTRUCTION_SEPARATOR);
      instructionBytes += separatorBytes + utf8Bytes(fragment.instructions);
      if (instructionBytes > PROFILE_LIMITS.instructionsBytes) {
        compositionFail(
          "too_many_bytes",
          `Composed instructions exceed ${PROFILE_LIMITS.instructionsBytes} UTF-8 bytes.`,
        );
      }
      instructions.push(fragment.instructions);
    }

    for (const file of fragment.seedFiles ?? []) {
      const key = portableCollisionKey(file.path);
      const prior = seedByPath.get(key);
      if (prior !== undefined) {
        if (prior.file.path !== file.path || prior.file.content !== file.content) {
          compositionFail(
            "seed_collision",
            `Seed file ${JSON.stringify(file.path)} from ${JSON.stringify(source)} collides with ${JSON.stringify(prior.file.path)} from ${JSON.stringify(prior.source)}.`,
          );
        }
        continue;
      }
      if (seedFiles.length >= PROFILE_LIMITS.seedFiles) {
        compositionFail(
          "too_many_seed_files",
          `Composed profile exceeds the ${PROFILE_LIMITS.seedFiles} seed file limit.`,
        );
      }
      totalSeedBytes += utf8Bytes(file.content);
      if (totalSeedBytes > PROFILE_LIMITS.totalSeedBytes) {
        compositionFail(
          "too_many_bytes",
          `Composed seed content exceeds ${PROFILE_LIMITS.totalSeedBytes} UTF-8 bytes.`,
        );
      }
      seedByPath.set(key, { file, source });
      seedFiles.push(file);
    }

    if (fragment.maxCostUsd !== undefined) {
      maxCostUsd =
        maxCostUsd === undefined ? fragment.maxCostUsd : Math.min(maxCostUsd, fragment.maxCostUsd);
    }
    if (fragment.maxTurns !== undefined) {
      maxTurns =
        maxTurns === undefined ? fragment.maxTurns : Math.min(maxTurns, fragment.maxTurns);
    }
    if (fragment.maxWallClockMs !== undefined) {
      maxWallClockMs =
        maxWallClockMs === undefined
          ? fragment.maxWallClockMs
          : Math.min(maxWallClockMs, fragment.maxWallClockMs);
    }
  }

  for (const key of scalarConflicts) {
    if (!Object.hasOwn(overrides, key)) {
      const choices = [...(scalarSources.get(key)?.entries() ?? [])]
        .map(
          ([value, sources]) =>
            `${JSON.stringify(value)} from ${sources.map((source) => JSON.stringify(source)).join(", ")}`,
        )
        .join("; ");
      compositionFail(
        "scalar_conflict",
        `Fragments disagree on ${key} (${choices}); finalOverrides.${key} is required.`,
      );
    }
  }

  const provider = overrides.provider ?? scalarValues.get("provider");
  const model = overrides.model ?? scalarValues.get("model");
  const resolvedThinking = (overrides.thinking ??
    scalarValues.get("thinking")) as ProfileThinking | undefined;
  const result: {
    provider?: string;
    model?: string;
    thinking?: ProfileThinking;
    tools: readonly string[];
    namedSkills: readonly string[];
    inlineSkills: readonly InlineProfileSkill[];
    instructions?: string;
    seedFiles: readonly StaticSeedFile[];
    maxCostUsd?: number;
    maxTurns?: number;
    maxWallClockMs?: number;
  } = {
    tools: Object.freeze([...tools]),
    namedSkills: Object.freeze([...namedSkills]),
    inlineSkills: Object.freeze(inlineSkills.map(freezeInlineSkill)),
    seedFiles: Object.freeze(seedFiles.map(freezeSeedFile)),
  };
  if (provider !== undefined) result.provider = provider;
  if (model !== undefined) result.model = model;
  if (resolvedThinking !== undefined) result.thinking = resolvedThinking;
  if (instructions.length > 0) {
    result.instructions = instructions.join(PROFILE_INSTRUCTION_SEPARATOR);
  }
  if (maxCostUsd !== undefined) result.maxCostUsd = maxCostUsd;
  if (maxTurns !== undefined) result.maxTurns = maxTurns;
  if (maxWallClockMs !== undefined) result.maxWallClockMs = maxWallClockMs;
  return Object.freeze(result);
}

export const PROFILE_CATALOGUE_VERSION = 1 as const;

export const PROFILE_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ProfileThinking = (typeof PROFILE_THINKING_LEVELS)[number];

export interface InlineProfileSkill {
  readonly name: string;
  readonly content: string;
}

export interface StaticSeedFile {
  /** Normalized, relative POSIX path suitable for any supported host OS. */
  readonly path: string;
  readonly content: string;
}

export interface ProfileScalarOverrides {
  readonly provider?: string;
  readonly model?: string;
  readonly thinking?: ProfileThinking;
}

/**
 * A composable, deliberately partial profile. Array order is significant:
 * composition retains the first occurrence of unioned values.
 */
export interface ProfileFragment extends ProfileScalarOverrides {
  readonly tools?: readonly string[];
  readonly namedSkills?: readonly string[];
  readonly inlineSkills?: readonly InlineProfileSkill[];
  readonly instructions?: string;
  readonly seedFiles?: readonly StaticSeedFile[];
  readonly maxCostUsd?: number;
  readonly maxTurns?: number;
  readonly maxWallClockMs?: number;
}

export interface ProfileDefinition {
  /** Fragment names in composition order. */
  readonly fragments: readonly string[];
  /**
   * Final scalar choices. A key must be present here when composed fragments
   * disagree about that scalar.
   */
  readonly overrides?: ProfileScalarOverrides;
}

export interface ProfileCatalogue {
  readonly version: typeof PROFILE_CATALOGUE_VERSION;
  readonly fragments: Readonly<Record<string, ProfileFragment>>;
  readonly profiles: Readonly<Record<string, ProfileDefinition>>;
}

/**
 * Fully composed library output. Optional scalars and budgets remain absent
 * when no fragment or final override supplies them.
 */
export interface ResolvedProfile extends ProfileScalarOverrides {
  readonly tools: readonly string[];
  readonly namedSkills: readonly string[];
  readonly inlineSkills: readonly InlineProfileSkill[];
  readonly instructions?: string;
  readonly seedFiles: readonly StaticSeedFile[];
  readonly maxCostUsd?: number;
  readonly maxTurns?: number;
  readonly maxWallClockMs?: number;
}

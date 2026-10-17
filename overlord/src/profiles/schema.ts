import { PROFILE_LIMITS } from "./limits.js";
import {
  PROFILE_CATALOGUE_VERSION,
  PROFILE_THINKING_LEVELS,
  type InlineProfileSkill,
  type ProfileCatalogue,
  type ProfileDefinition,
  type ProfileFragment,
  type ProfileScalarOverrides,
  type ProfileThinking,
  type StaticSeedFile,
} from "./types.js";

export class ProfileValidationError extends Error {
  constructor(
    message: string,
    readonly location: string,
    options?: ErrorOptions,
  ) {
    super(`${location}: ${message}`, options);
    this.name = "ProfileValidationError";
  }
}

function fail(location: string, message: string, options?: ErrorOptions): never {
  throw new ProfileValidationError(message, location, options);
}

export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function plainObject(value: unknown, location: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(location, "must be an object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(location, "must be a plain JSON object");
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  location: string,
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    fail(location, `unknown field(s): ${unknown.join(", ")}`);
  }
}

function boundedString(
  value: unknown,
  location: string,
  maxBytes: number,
  options: { allowEmpty?: boolean; trim?: boolean } = {},
): string {
  if (typeof value !== "string") fail(location, "must be a string");
  if (options.trim === true && value.trim() !== value) {
    fail(location, "must not have leading or trailing whitespace");
  }
  if (options.allowEmpty !== true && value.length === 0) {
    fail(location, "must not be empty");
  }
  const bytes = utf8Bytes(value);
  if (bytes > maxBytes) fail(location, `must encode to at most ${maxBytes} UTF-8 bytes`);
  return value;
}

function assertCount(
  values: readonly unknown[],
  location: string,
  maximum: number,
  allowEmpty = true,
): void {
  if (!allowEmpty && values.length === 0) fail(location, "must not be empty");
  if (values.length > maximum) fail(location, `must contain at most ${maximum} entries`);
}

/**
 * Validates names used as catalogue keys and symbolic references. Names may be
 * slash-namespaced, but every segment must be non-empty and traversal-free.
 */
export function parseProfileName(value: unknown, location = "name"): string {
  const name = boundedString(value, location, PROFILE_LIMITS.nameBytes, { trim: true });
  if (name.includes("\\") || name.startsWith("/") || name.endsWith("/")) {
    fail(location, "must be a portable symbolic name");
  }
  const segments = name.split("/");
  if (
    segments.some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        !/^[A-Za-z0-9@_.:-]+$/.test(segment),
    )
  ) {
    fail(
      location,
      "must use traversal-free slash-separated segments containing only letters, digits, @, _, ., :, or -",
    );
  }
  return name;
}

/** Skill ids mirror Ling's fixed and inline skill-name wire contract. */
export function parseSkillName(value: unknown, location = "skill name"): string {
  const name = boundedString(value, location, 64, { trim: true });
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    fail(location, "must use lowercase letters, digits, and single hyphens");
  }
  return name;
}

function scalarString(value: unknown, location: string): string {
  const parsed = boundedString(value, location, PROFILE_LIMITS.scalarBytes, { trim: true });
  if (/[\u0000-\u001f\u007f]/u.test(parsed)) {
    fail(location, "must not contain control characters");
  }
  return parsed;
}

function thinking(value: unknown, location: string): ProfileThinking {
  if (
    typeof value !== "string" ||
    !PROFILE_THINKING_LEVELS.includes(value as ProfileThinking)
  ) {
    fail(location, `must be one of: ${PROFILE_THINKING_LEVELS.join(", ")}`);
  }
  return value as ProfileThinking;
}

function positiveFinite(value: unknown, location: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    fail(location, "must be a positive finite number");
  }
  return value;
}

function positiveSafeInteger(value: unknown, location: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    fail(location, "must be a positive safe integer");
  }
  return value;
}

function parseNameArray(value: unknown, location: string, maximum: number): string[] {
  if (!Array.isArray(value)) fail(location, "must be an array");
  assertCount(value, location, maximum);
  return value.map((item, index) => parseProfileName(item, `${location}[${index}]`));
}

function parseSkillNameArray(value: unknown, location: string, maximum: number): string[] {
  if (!Array.isArray(value)) fail(location, "must be an array");
  assertCount(value, location, maximum);
  const parsed = value.map((item, index) => parseSkillName(item, `${location}[${index}]`));
  if (new Set(parsed).size !== parsed.length) fail(location, "must not contain duplicate skill ids");
  return parsed;
}

const WINDOWS_RESERVED_BASENAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
]);

/**
 * Produces a normalized relative POSIX seed path. Backslashes, absolute paths,
 * drive paths, traversal segments, and names invalid on common host file
 * systems are rejected. Benign repeated separators and `.` segments collapse.
 */
export function normalizeSeedPath(value: unknown, location = "path"): string {
  const input = boundedString(value, location, PROFILE_LIMITS.seedPathBytes);
  if (
    input.includes("\\") ||
    input.startsWith("/") ||
    /^[A-Za-z]:/u.test(input) ||
    /[\u0000-\u001f\u007f]/u.test(input)
  ) {
    fail(location, "must be a relative portable path using forward slashes");
  }

  const rawSegments = input.split("/");
  if (rawSegments.includes("..")) fail(location, "must not contain path traversal");
  const segments = rawSegments
    .filter((segment) => segment !== "" && segment !== ".")
    .map((segment) => segment.normalize("NFC"));
  if (segments.length === 0) fail(location, "must identify a file");

  for (const segment of segments) {
    if (
      /[<>:"|?*]/u.test(segment) ||
      segment.endsWith(".") ||
      segment.endsWith(" ") ||
      utf8Bytes(segment) > 255
    ) {
      fail(location, `contains non-portable path segment ${JSON.stringify(segment)}`);
    }
    const basename = segment.split(".", 1)[0]?.toLowerCase();
    if (basename !== undefined && WINDOWS_RESERVED_BASENAMES.has(basename)) {
      fail(location, `contains reserved path segment ${JSON.stringify(segment)}`);
    }
  }

  const normalized = segments.join("/");
  if (utf8Bytes(normalized) > PROFILE_LIMITS.seedPathBytes) {
    fail(location, `must normalize to at most ${PROFILE_LIMITS.seedPathBytes} UTF-8 bytes`);
  }
  return normalized;
}

function parseInlineSkills(value: unknown, location: string): InlineProfileSkill[] {
  if (!Array.isArray(value)) fail(location, "must be an array");
  assertCount(value, location, PROFILE_LIMITS.inlineSkills);
  const seen = new Set<string>();
  let totalBytes = 0;
  return value.map((item, index) => {
    const itemLocation = `${location}[${index}]`;
    const raw = plainObject(item, itemLocation);
    exactKeys(raw, ["name", "content"], itemLocation);
    const name = parseSkillName(raw["name"], `${itemLocation}.name`);
    if (seen.has(name)) fail(`${itemLocation}.name`, `duplicates inline skill ${JSON.stringify(name)}`);
    seen.add(name);
    const content = boundedString(
      raw["content"],
      `${itemLocation}.content`,
      PROFILE_LIMITS.inlineSkillBytes,
    );
    totalBytes += utf8Bytes(content);
    if (totalBytes > PROFILE_LIMITS.totalInlineSkillBytes) {
      fail(location, `content must total at most ${PROFILE_LIMITS.totalInlineSkillBytes} UTF-8 bytes`);
    }
    return { name, content };
  });
}

function portableCollisionKey(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

function parseSeedFiles(value: unknown, location: string): StaticSeedFile[] {
  if (!Array.isArray(value)) fail(location, "must be an array");
  assertCount(value, location, PROFILE_LIMITS.seedFiles);
  const seen = new Map<string, StaticSeedFile>();
  let totalBytes = 0;
  return value.map((item, index) => {
    const itemLocation = `${location}[${index}]`;
    const raw = plainObject(item, itemLocation);
    exactKeys(raw, ["path", "content"], itemLocation);
    const path = normalizeSeedPath(raw["path"], `${itemLocation}.path`);
    const content = boundedString(
      raw["content"],
      `${itemLocation}.content`,
      PROFILE_LIMITS.seedFileBytes,
      { allowEmpty: true },
    );
    const key = portableCollisionKey(path);
    const prior = seen.get(key);
    if (prior !== undefined && (prior.path !== path || prior.content !== content)) {
      fail(`${itemLocation}.path`, `collides with seed path ${JSON.stringify(prior.path)}`);
    }
    if (prior === undefined) {
      seen.set(key, { path, content });
      totalBytes += utf8Bytes(content);
      if (totalBytes > PROFILE_LIMITS.totalSeedBytes) {
        fail(location, `content must total at most ${PROFILE_LIMITS.totalSeedBytes} UTF-8 bytes`);
      }
    }
    return { path, content };
  });
}

export function parseProfileScalarOverrides(
  value: unknown,
  location = "overrides",
): ProfileScalarOverrides {
  const raw = plainObject(value, location);
  exactKeys(raw, ["provider", "model", "thinking"], location);
  const result: {
    provider?: string;
    model?: string;
    thinking?: ProfileThinking;
  } = {};
  if (Object.hasOwn(raw, "provider")) {
    result.provider = scalarString(raw["provider"], `${location}.provider`);
  }
  if (Object.hasOwn(raw, "model")) {
    result.model = scalarString(raw["model"], `${location}.model`);
  }
  if (Object.hasOwn(raw, "thinking")) {
    result.thinking = thinking(raw["thinking"], `${location}.thinking`);
  }
  return result;
}

export function parseProfileFragment(value: unknown, location = "fragment"): ProfileFragment {
  const raw = plainObject(value, location);
  exactKeys(
    raw,
    [
      "provider",
      "model",
      "thinking",
      "tools",
      "namedSkills",
      "inlineSkills",
      "instructions",
      "seedFiles",
      "maxCostUsd",
      "maxTurns",
      "maxWallClockMs",
    ],
    location,
  );
  const result: {
    provider?: string;
    model?: string;
    thinking?: ProfileThinking;
    tools?: string[];
    namedSkills?: string[];
    inlineSkills?: InlineProfileSkill[];
    instructions?: string;
    seedFiles?: StaticSeedFile[];
    maxCostUsd?: number;
    maxTurns?: number;
    maxWallClockMs?: number;
  } = {};

  if (Object.hasOwn(raw, "provider")) {
    result.provider = scalarString(raw["provider"], `${location}.provider`);
  }
  if (Object.hasOwn(raw, "model")) {
    result.model = scalarString(raw["model"], `${location}.model`);
  }
  if (Object.hasOwn(raw, "thinking")) {
    result.thinking = thinking(raw["thinking"], `${location}.thinking`);
  }
  if (Object.hasOwn(raw, "tools")) {
    result.tools = parseNameArray(raw["tools"], `${location}.tools`, PROFILE_LIMITS.tools);
  }
  if (Object.hasOwn(raw, "namedSkills")) {
    result.namedSkills = parseSkillNameArray(
      raw["namedSkills"],
      `${location}.namedSkills`,
      PROFILE_LIMITS.namedSkills,
    );
  }
  if (Object.hasOwn(raw, "inlineSkills")) {
    result.inlineSkills = parseInlineSkills(raw["inlineSkills"], `${location}.inlineSkills`);
  }
  if (Object.hasOwn(raw, "instructions")) {
    result.instructions = boundedString(
      raw["instructions"],
      `${location}.instructions`,
      PROFILE_LIMITS.instructionsBytes,
    );
  }
  if (Object.hasOwn(raw, "seedFiles")) {
    result.seedFiles = parseSeedFiles(raw["seedFiles"], `${location}.seedFiles`);
  }
  if (Object.hasOwn(raw, "maxCostUsd")) {
    result.maxCostUsd = positiveFinite(raw["maxCostUsd"], `${location}.maxCostUsd`);
  }
  if (Object.hasOwn(raw, "maxTurns")) {
    result.maxTurns = positiveSafeInteger(raw["maxTurns"], `${location}.maxTurns`);
  }
  if (Object.hasOwn(raw, "maxWallClockMs")) {
    result.maxWallClockMs = positiveSafeInteger(
      raw["maxWallClockMs"],
      `${location}.maxWallClockMs`,
    );
  }
  return result;
}

function parseProfileDefinition(value: unknown, location: string): ProfileDefinition {
  const raw = plainObject(value, location);
  exactKeys(raw, ["fragments", "overrides"], location);
  const fragments = parseNameArray(
    raw["fragments"],
    `${location}.fragments`,
    PROFILE_LIMITS.fragmentReferences,
  );
  assertCount(fragments, `${location}.fragments`, PROFILE_LIMITS.fragmentReferences, false);
  return {
    fragments,
    ...(Object.hasOwn(raw, "overrides")
      ? { overrides: parseProfileScalarOverrides(raw["overrides"], `${location}.overrides`) }
      : {}),
  };
}

function encodedJsonBytes(value: unknown, location: string): number {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch (error) {
    fail(location, "must be JSON-serializable", { cause: error });
  }
  if (encoded === undefined) fail(location, "must be JSON-serializable");
  return utf8Bytes(encoded);
}

export function parseProfileCatalogue(value: unknown): ProfileCatalogue {
  const bytes = encodedJsonBytes(value, "catalogue");
  if (bytes > PROFILE_LIMITS.catalogueBytes) {
    fail("catalogue", `must encode to at most ${PROFILE_LIMITS.catalogueBytes} UTF-8 bytes`);
  }

  const raw = plainObject(value, "catalogue");
  exactKeys(raw, ["version", "fragments", "profiles"], "catalogue");
  if (raw["version"] !== PROFILE_CATALOGUE_VERSION) {
    fail("catalogue.version", `unsupported version ${String(raw["version"])}`);
  }

  const rawFragments = plainObject(raw["fragments"], "catalogue.fragments");
  const fragmentEntries = Object.entries(rawFragments);
  assertCount(fragmentEntries, "catalogue.fragments", PROFILE_LIMITS.fragments);
  const fragments = Object.create(null) as Record<string, ProfileFragment>;
  for (const [unparsedName, value] of fragmentEntries) {
    const name = parseProfileName(unparsedName, `catalogue.fragments key ${JSON.stringify(unparsedName)}`);
    fragments[name] = parseProfileFragment(value, `catalogue.fragments[${JSON.stringify(name)}]`);
  }

  const rawProfiles = plainObject(raw["profiles"], "catalogue.profiles");
  const profileEntries = Object.entries(rawProfiles);
  assertCount(profileEntries, "catalogue.profiles", PROFILE_LIMITS.profiles);
  const profiles = Object.create(null) as Record<string, ProfileDefinition>;
  for (const [unparsedName, value] of profileEntries) {
    const name = parseProfileName(unparsedName, `catalogue.profiles key ${JSON.stringify(unparsedName)}`);
    const definition = parseProfileDefinition(
      value,
      `catalogue.profiles[${JSON.stringify(name)}]`,
    );
    definition.fragments.forEach((fragmentName, index) => {
      if (!Object.hasOwn(fragments, fragmentName)) {
        fail(
          `catalogue.profiles[${JSON.stringify(name)}].fragments[${index}]`,
          `references unknown fragment ${JSON.stringify(fragmentName)}`,
        );
      }
    });
    profiles[name] = definition;
  }

  return {
    version: PROFILE_CATALOGUE_VERSION,
    fragments,
    profiles,
  };
}

export function parseProfileCatalogueJson(json: string): ProfileCatalogue {
  if (typeof json !== "string") fail("catalogue JSON", "must be a string");
  if (utf8Bytes(json) > PROFILE_LIMITS.catalogueBytes) {
    fail("catalogue JSON", `must be at most ${PROFILE_LIMITS.catalogueBytes} UTF-8 bytes`);
  }
  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch (error) {
    fail("catalogue JSON", "must contain valid JSON", { cause: error });
  }
  return parseProfileCatalogue(value);
}

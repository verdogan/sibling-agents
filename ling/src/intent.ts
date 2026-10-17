/**
 * Declared intent: what a task says it is about to do, before it does it.
 *
 * Every other check in this service asks whether a claim about the *world*
 * survives re-checking. None asks whether the task's account of its own *work*
 * is true, so a task that reports "ran the test suite, all green" without
 * invoking anything passes every gate. What closes that is a commitment made
 * before the fact: the task declares the programs it will run, the hosts it
 * will contact and the paths it will write, and the caller compares that
 * against the tool calls the harness actually recorded.
 *
 * The value is entirely in the ordering. A declaration made after the work is
 * a description, and a description can be fitted to whatever happened; a
 * declaration made before it has to be right about a future the task does not
 * yet know. So the wire shape carries no timestamp of its own — position in the
 * event log is the timestamp, and it is not something a task can edit.
 *
 * Position is only a timestamp if the log puts a declaration where it was
 * made. Pi starts every call of a message before it runs any of them, unless
 * one is sequential, and the declaration is logged as it runs. declare_intent
 * is sequential (features/intent.ts), so a declaration sent in one message with
 * the actions it covers is logged before they start, and one sent after them
 * is logged after they end.
 *
 * A declaration also has to be falsifiable to be worth anything, which is why
 * wildcards are refused here rather than discouraged in the prompt. "I may run
 * any command" is not a declaration, it is a refusal to make one.
 */

export const DECLARE_INTENT_TOOL_NAME = "declare_intent";

/** Emitted on the task's normal event channel, one per accepted declaration. */
export const INTENT_EVENT_TYPE = "intent_declared";

export const MAX_INTENT_ENTRIES = 32;
export const MAX_INTENT_ENTRY_CHARS = 200;
export const MAX_INTENT_NOTE_CHARS = 500;

/**
 * Exact data emitted by the declare_intent task tool.
 *
 * `commands` are program names rather than command lines: a task cannot predict
 * its own argument strings, and requiring it to would make honest declarations
 * fail. `writes` may name a directory with a trailing slash, which widens the
 * declaration to everything beneath it. That is a bounded, visible widening
 * rather than a wildcard, and an over-broad one is still readable as such.
 */
export interface IntentDeclaration {
  commands: string[];
  hosts: string[];
  writes: string[];
  note?: string;
}

export class IntentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntentValidationError";
  }
}

/** Shell metacharacters and globs, which would make an entry unfalsifiable. */
const WILDCARD = /[*?[\]{}]/;

function normalizeEntries(
  values: readonly unknown[],
  field: string,
  normalize: (value: string) => string,
): string[] {
  if (values.length > MAX_INTENT_ENTRIES) {
    throw new IntentValidationError(
      `"${field}" must contain at most ${MAX_INTENT_ENTRIES} entries.`,
    );
  }
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new IntentValidationError(`"${field}" entries must be non-empty strings.`);
    }
    if (value.length > MAX_INTENT_ENTRY_CHARS) {
      throw new IntentValidationError(
        `"${field}" entries must be at most ${MAX_INTENT_ENTRY_CHARS} characters.`,
      );
    }
    if (WILDCARD.test(value)) {
      throw new IntentValidationError(
        `"${field}" entry ${JSON.stringify(value)} contains a wildcard. Declare each item you intend to touch; a pattern cannot be checked against what you did.`,
      );
    }
    seen.add(normalize(value));
  }
  return [...seen];
}

/** A program name, reduced the same way an observed command line will be. */
export function normalizeProgram(value: string): string {
  const trimmed = value.trim().replace(/^["']|["']$/g, "");
  const base = trimmed.split(/[/\\]/).pop() ?? trimmed;
  return base.toLowerCase();
}

export function normalizeHost(value: string): string {
  const trimmed = value.trim().toLowerCase();
  // Accept a bare hostname or a full URL, since a task thinking about what it
  // will fetch is holding a URL rather than a hostname.
  if (trimmed.includes("://")) {
    try {
      return new URL(trimmed).hostname;
    } catch {
      throw new IntentValidationError(`"hosts" entry ${JSON.stringify(value)} is not a valid URL.`);
    }
  }
  return trimmed.replace(/\/+$/, "");
}

/**
 * A workspace-relative POSIX path, or a directory with a trailing slash.
 *
 * Refuses anything that resolves to the workspace root: a declaration covering
 * every path is the wildcard this function exists to reject, spelled without a
 * wildcard character.
 */
export function normalizeWritePath(value: string): string {
  const trimmed = value.trim().replaceAll("\\", "/");
  const directory = trimmed.endsWith("/");
  const withoutSlash = trimmed.replace(/\/+$/, "");
  const segments: string[] = [];
  for (const segment of withoutSlash.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      throw new IntentValidationError(
        `"writes" entry ${JSON.stringify(value)} must stay inside the workspace.`,
      );
    }
    segments.push(segment);
  }
  if (segments.length === 0) {
    throw new IntentValidationError(
      `"writes" entry ${JSON.stringify(value)} covers the whole workspace, which declares nothing. Name the paths you intend to write.`,
    );
  }
  return segments.join("/") + (directory ? "/" : "");
}

/** Validate and normalize one declaration. Throws rather than coercing. */
export function parseIntentDeclaration(input: unknown): IntentDeclaration {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new IntentValidationError("A declaration must be a JSON object.");
  }
  const raw = input as Record<string, unknown>;
  const accepted = new Set(["commands", "hosts", "writes", "note"]);
  const unknown = Object.keys(raw).filter((key) => !accepted.has(key));
  if (unknown.length > 0) {
    throw new IntentValidationError(`Unknown field(s): ${unknown.join(", ")}.`);
  }
  for (const field of ["commands", "hosts", "writes"] as const) {
    if (!Array.isArray(raw[field])) {
      throw new IntentValidationError(`"${field}" must be an array.`);
    }
  }
  const note = raw["note"];
  if (note !== undefined) {
    if (typeof note !== "string" || note.trim() === "") {
      throw new IntentValidationError('"note" must be a non-empty string when present.');
    }
    if (note.length > MAX_INTENT_NOTE_CHARS) {
      throw new IntentValidationError(
        `"note" must be at most ${MAX_INTENT_NOTE_CHARS} characters.`,
      );
    }
  }
  return {
    commands: normalizeEntries(raw["commands"] as unknown[], "commands", normalizeProgram),
    hosts: normalizeEntries(raw["hosts"] as unknown[], "hosts", normalizeHost),
    writes: normalizeEntries(raw["writes"] as unknown[], "writes", normalizeWritePath),
    ...(note === undefined ? {} : { note: note as string }),
  };
}

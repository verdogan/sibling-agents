import { lstatSync, readdirSync, type Dirent } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const MAX_SKILL_NAME_CHARS = 64;
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface InlineSkill {
  name: string;
  /** Complete contents of this skill's SKILL.md file. */
  content: string;
}

export interface InlineSkillLimits {
  maxCount: number;
  maxBytesPerSkill: number;
  maxTotalBytes: number;
}

export type NamedSkillCatalog = ReadonlyMap<string, string>;

export function isSafeSkillName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= MAX_SKILL_NAME_CHARS &&
    SKILL_NAME_PATTERN.test(name)
  );
}

/**
 * If SKILL.md frontmatter declares a name, require it to be the same safe name
 * used for its directory. Pi otherwise prefers frontmatter over the directory
 * name, which could let inline content shadow a fixed feature skill.
 */
export function validateInlineSkillDocumentName(
  expectedName: string,
  content: string,
): string | undefined {
  const normalized = content.replace(/\r\n?/g, "\n");
  if (!normalized.startsWith("---\n")) return undefined;
  const end = normalized.indexOf("\n---", 4);
  if (end < 0) return undefined;
  const frontmatter = normalized.slice(4, end);
  const declarations = frontmatter
    .split("\n")
    .map((line) => line.match(/^\s*(?:name|"name"|'name')\s*:\s*(.*?)\s*$/)?.[1])
    .filter((value): value is string => value !== undefined);
  if (declarations.length === 0) return undefined;
  if (declarations.length > 1) return "SKILL.md frontmatter must declare name at most once.";

  const raw = declarations[0] ?? "";
  let declared = raw;
  if (raw.startsWith('"') || raw.endsWith('"')) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed !== "string") throw new Error("not a string");
      declared = parsed;
    } catch {
      return "SKILL.md frontmatter name must be a plain or quoted string.";
    }
  } else if (raw.startsWith("'") || raw.endsWith("'")) {
    if (!(raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2)) {
      return "SKILL.md frontmatter name must be a plain or quoted string.";
    }
    declared = raw.slice(1, -1).replace(/''/g, "'");
  }

  if (!isSafeSkillName(declared) || declared !== expectedName) {
    return `SKILL.md frontmatter name must equal ${JSON.stringify(expectedName)}.`;
  }
  return undefined;
}

/**
 * Discover image-provided skills by safe, direct child directory name.
 *
 * Symlinks are deliberately excluded. A caller-selected name can therefore
 * resolve only to a fixed directory and fixed SKILL.md beneath agent/skills,
 * never to an operator- or caller-provided path.
 */
export function discoverNamedSkills(skillsDir: string): NamedSkillCatalog {
  const catalog = new Map<string, string>();
  let entries: Dirent[];
  try {
    entries = readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return catalog;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !isSafeSkillName(entry.name)) {
      continue;
    }
    const skillDir = path.join(skillsDir, entry.name);
    const skillFile = path.join(skillDir, "SKILL.md");
    try {
      const skillFileStat = lstatSync(skillFile);
      if (!skillFileStat.isFile() || skillFileStat.isSymbolicLink()) continue;
    } catch {
      continue;
    }
    catalog.set(entry.name, skillDir);
  }

  return new Map([...catalog].sort(([left], [right]) => left.localeCompare(right)));
}

export function resolveNamedSkillPaths(
  catalog: NamedSkillCatalog,
  names: readonly string[],
): string[] {
  return names.map((name) => {
    const skillPath = catalog.get(name);
    if (skillPath === undefined) {
      throw new Error(`Named skill ${JSON.stringify(name)} is not available on this worker.`);
    }
    return skillPath;
  });
}

/**
 * Write caller-provided SKILL.md files below a task-private runtime root.
 * Names have already passed HTTP policy validation, but are checked again at
 * the filesystem boundary so restored or manually-written queue data cannot
 * turn into a path.
 */
export async function materializeInlineSkills(
  taskRuntimeDir: string,
  skills: readonly InlineSkill[],
  limits: InlineSkillLimits,
): Promise<string[]> {
  if (skills.length === 0) return [];
  if (skills.length > limits.maxCount) {
    throw new Error(`Task has ${skills.length} inline skills; the worker limit is ${limits.maxCount}.`);
  }

  await rm(taskRuntimeDir, { recursive: true, force: true });
  const skillsRoot = path.join(taskRuntimeDir, "skills");
  await mkdir(skillsRoot, { recursive: true, mode: 0o700 });

  const paths: string[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const skill of skills) {
    if (!isSafeSkillName(skill.name)) {
      throw new Error(`Unsafe inline skill name ${JSON.stringify(skill.name)}.`);
    }
    const documentNameError = validateInlineSkillDocumentName(skill.name, skill.content);
    if (documentNameError !== undefined) {
      throw new Error(`Inline skill ${JSON.stringify(skill.name)}: ${documentNameError}`);
    }
    if (seen.has(skill.name)) {
      throw new Error(`Duplicate inline skill name ${JSON.stringify(skill.name)}.`);
    }
    const contentBytes = Buffer.byteLength(skill.content);
    if (skill.content.trim() === "" || contentBytes > limits.maxBytesPerSkill) {
      throw new Error(
        `Inline skill ${JSON.stringify(skill.name)} must contain 1-${limits.maxBytesPerSkill} bytes.`,
      );
    }
    totalBytes += contentBytes;
    if (totalBytes > limits.maxTotalBytes) {
      throw new Error(`Inline skills exceed the ${limits.maxTotalBytes}-byte worker limit.`);
    }
    seen.add(skill.name);
    const skillDir = path.join(skillsRoot, skill.name);
    await mkdir(skillDir, { mode: 0o700 });
    await writeFile(path.join(skillDir, "SKILL.md"), skill.content, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    paths.push(skillDir);
  }
  return paths;
}

export async function cleanupTaskSkills(taskRuntimeDir: string): Promise<void> {
  await rm(taskRuntimeDir, { recursive: true, force: true });
}

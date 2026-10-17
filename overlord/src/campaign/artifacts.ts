import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LingTask } from "../ling/types.js";
import type { ArtifactRef } from "./schema.js";

export const MAX_CAMPAIGN_SEED_FILES = 20;
export const MAX_CAMPAIGN_SEED_BYTES = 256 * 1024;
export const MAX_CAMPAIGN_SEED_PATH_CHARS = 240;
export const MAX_LING_REQUEST_BODY_BYTES = 512 * 1024;

export interface ArtifactClaim {
  path: string;
  sha256?: string;
}

export interface ArtifactSeed {
  ref: ArtifactRef;
  path: string;
}

export interface TaskArtifactTransport {
  listArtifacts(
    taskId: string,
    workerId?: string,
  ): Promise<{ files: Array<{ path: string; size: number; sha256: string }> }>;
  readArtifact(taskId: string, artifactPath: string, workerId?: string): Promise<Uint8Array>;
}

export type ArtifactRedactor = (content: string) => string;

export function artifactSourcePath(ref: ArtifactRef): string {
  const segments = ref.path.split("/");
  const digestIndex = segments.lastIndexOf(ref.sha256);
  const source = digestIndex < 0 ? [] : segments.slice(digestIndex + 1);
  if (source.length === 0) {
    throw new ArtifactTransportError(
      `Campaign artifact ${ref.path} does not retain a source path.`,
      "invalid_path",
    );
  }
  return source.join("/");
}

export class ArtifactTransportError extends Error {
  constructor(
    message: string,
    readonly code:
      | "transport_unavailable"
      | "invalid_path"
      | "missing"
      | "not_regular"
      | "not_text"
      | "hash_mismatch"
      | "too_many_files"
      | "too_many_bytes"
      | "collision",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ArtifactTransportError";
  }
}

export function artifactRedactorFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ArtifactRedactor {
  const secrets = Object.entries(env)
    .filter(
      ([name, value]) =>
        value !== undefined &&
        value.length >= 8 &&
        /(?:TOKEN|API_KEY|SECRET|PASSWORD|CREDENTIAL)/i.test(name),
    )
    .sort((left, right) => (right[1]?.length ?? 0) - (left[1]?.length ?? 0));
  return (content: string): string => {
    let redacted = content;
    for (const [name, value] of secrets) {
      if (value !== undefined) redacted = redacted.replaceAll(value, `[REDACTED:${name}]`);
    }
    return redacted
      .replace(/sk-(?:proj-)?[A-Za-z0-9_-]{16,}/g, "[REDACTED:API_KEY]")
      .replace(/gh[opusr]_[A-Za-z0-9]{20,}/g, "[REDACTED:GITHUB_TOKEN]")
      .replace(/AKIA[A-Z0-9]{16}/g, "[REDACTED:AWS_ACCESS_KEY]")
      .replace(
        /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
        "[REDACTED:PRIVATE_KEY]",
      )
      .replace(
        /\b(authorization\s*:\s*bearer\s+)[A-Za-z0-9._~+/-]{12,}={0,2}/gi,
        "$1[REDACTED:TOKEN]",
      );
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function portableRelative(value: string, label: string): string {
  const normalized = path.posix.normalize(value);
  if (
    value.trim() === "" ||
    value.length > MAX_CAMPAIGN_SEED_PATH_CHARS ||
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized !== value
  ) {
    throw new ArtifactTransportError(
      `${label} ${JSON.stringify(value)} must be a normalized relative POSIX path.`,
      "invalid_path",
    );
  }
  return normalized;
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

/**
 * A definite "the file is not there", as distinct from "the answer never came".
 *
 * The distinction is load-bearing wherever absence is a legitimate outcome:
 * treating an unreachable worker as one that honestly produced nothing hands a
 * clean record to whatever broke, or to whatever wanted to look broken. The
 * duck-typed status check mirrors the one in the driver so this module does not
 * have to depend on the HTTP client.
 */
function isDefinitelyAbsent(error: unknown): boolean {
  if (error instanceof ArtifactTransportError) return error.code === "missing";
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status?: unknown }).status === 404
  );
}

function decodeText(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new ArtifactTransportError(
      `${label} is not valid UTF-8; campaign artifact transport is text-only.`,
      "not_text",
      { cause: error },
    );
  }
}

export class CampaignArtifactStore {
  readonly rootDir: string;
  readonly workspacesDir: string;
  private readonly transport: TaskArtifactTransport | undefined;
  private readonly redact: ArtifactRedactor;

  constructor(
    rootDir: string,
    workspacesDir: string,
    transport?: TaskArtifactTransport,
    redact: ArtifactRedactor = artifactRedactorFromEnv(),
  ) {
    this.rootDir = path.resolve(rootDir);
    this.workspacesDir = path.resolve(workspacesDir);
    this.transport = transport;
    this.redact = redact;
  }

  async storeText(namespace: string, sourcePath: string, content: string): Promise<ArtifactRef> {
    const safeNamespace = portableRelative(namespace, "Artifact namespace");
    const safeSourcePath = portableRelative(sourcePath, "Artifact source path");
    const bytes = Buffer.from(content, "utf8");
    const digest = sha256(bytes);
    const relativePath = path.posix.join("artifacts", safeNamespace, digest, safeSourcePath);
    const destination = this.resolveArtifactPath(relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    try {
      await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
    } catch (error) {
      const existing = await readFile(destination).catch(() => undefined);
      if (existing === undefined || sha256(existing) !== digest) {
        throw new ArtifactTransportError(
          `Unable to persist immutable campaign artifact ${relativePath}.`,
          "collision",
          { cause: error },
        );
      }
    }
    return { artifactId: `sha256:${digest}`, path: relativePath, sha256: digest };
  }

  async readText(ref: ArtifactRef): Promise<string> {
    const bytes = await this.readVerified(ref);
    return decodeText(bytes, `Artifact ${ref.path}`);
  }

  async seedArtifacts(seeds: readonly ArtifactSeed[]): Promise<Record<string, string>> {
    const files: Record<string, string> = {};
    for (const seed of seeds) {
      const destination = portableRelative(seed.path, "Seed destination");
      if (Object.hasOwn(files, destination)) {
        throw new ArtifactTransportError(
          `Multiple campaign artifacts map to seeded file ${destination}.`,
          "collision",
        );
      }
      files[destination] = await this.readText(seed.ref);
    }
    assertSeedFileLimits(files);
    return files;
  }

  async collectTaskArtifacts(
    task: LingTask,
    claims: readonly ArtifactClaim[],
    namespace: string,
  ): Promise<ArtifactRef[]> {
    if (claims.length === 0) {
      throw new ArtifactTransportError("A campaign worker returned no artifacts.", "missing");
    }
    if (claims.length > MAX_CAMPAIGN_SEED_FILES) {
      throw new ArtifactTransportError(
        `Worker returned ${claims.length} artifacts; at most ${MAX_CAMPAIGN_SEED_FILES} are supported.`,
        "too_many_files",
      );
    }
    const expectedWorkspace = path.join(this.workspacesDir, task.id);
    const useLocal = samePath(task.workspaceDir, expectedWorkspace);
    if (!useLocal && this.transport === undefined) {
      throw new ArtifactTransportError(
        `Task ${task.id} is remote and no authenticated artifact transport is configured.`,
        "transport_unavailable",
      );
    }
    const seen = new Set<string>();
    const collected: ArtifactRef[] = [];
    let totalBytes = 0;
    for (const claim of claims) {
      const claimedPath = portableRelative(claim.path, "Worker artifact path");
      if (claimedPath === "result.json" || claimedPath === "events.jsonl") {
        throw new ArtifactTransportError(
          `Worker artifact ${claimedPath} is reserved operational data.`,
          "invalid_path",
        );
      }
      if (seen.has(claimedPath)) {
        throw new ArtifactTransportError(
          `Worker returned duplicate artifact path ${claimedPath}.`,
          "collision",
        );
      }
      seen.add(claimedPath);

      let bytes: Uint8Array;
      if (useLocal) {
        bytes = await this.readLocalTaskArtifact(expectedWorkspace, claimedPath);
      } else {
        bytes = await this.transport!.readArtifact(task.id, claimedPath, task.workerId);
      }
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_CAMPAIGN_SEED_BYTES) {
        throw new ArtifactTransportError(
          `Worker artifacts total ${totalBytes} bytes; the text transport limit is ${MAX_CAMPAIGN_SEED_BYTES}.`,
          "too_many_bytes",
        );
      }
      const text = decodeText(bytes, `Worker artifact ${claimedPath}`);
      const digest = sha256(bytes);
      if (claim.sha256 !== undefined && claim.sha256 !== digest) {
        throw new ArtifactTransportError(
          `Worker hash claim for ${claimedPath} did not match the collected bytes.`,
          "hash_mismatch",
        );
      }
      collected.push(await this.storeText(namespace, claimedPath, this.redact(text)));
    }
    return collected;
  }

  /**
   * Collect a file the overlord requires whether or not the worker mentioned it.
   *
   * Claim-driven collection is right for deliverables — the worker knows what it
   * produced — but wrong for evidence. A task that fabricates its findings and
   * then leaves `findings.json` out of `result.json` would be collected as having
   * produced nothing, and an empty finding set is not gradeable, so the omission
   * scores better than the fabrication it hides. This path therefore never
   * consults the worker's claims.
   *
   * Returns undefined only for a definite absence, which is the honest case of a
   * task that genuinely recorded nothing. Every other failure propagates:
   * reading a transport error as "recorded nothing" would restore the exact
   * bypass this method exists to close.
   */
  async collectRequiredFile(
    task: LingTask,
    filePath: string,
    namespace: string,
  ): Promise<ArtifactRef | undefined> {
    const wanted = portableRelative(filePath, "Required artifact path");
    if (wanted === "result.json" || wanted === "events.jsonl") {
      throw new ArtifactTransportError(
        `Worker artifact ${wanted} is reserved operational data.`,
        "invalid_path",
      );
    }
    const expectedWorkspace = path.join(this.workspacesDir, task.id);
    const useLocal = samePath(task.workspaceDir, expectedWorkspace);
    if (!useLocal && this.transport === undefined) {
      throw new ArtifactTransportError(
        `Task ${task.id} is remote and no authenticated artifact transport is configured.`,
        "transport_unavailable",
      );
    }

    let bytes: Uint8Array;
    try {
      bytes = useLocal
        ? await this.readLocalTaskArtifact(expectedWorkspace, wanted)
        : await this.transport!.readArtifact(task.id, wanted, task.workerId);
    } catch (error) {
      if (isDefinitelyAbsent(error)) return undefined;
      throw error;
    }

    if (bytes.byteLength > MAX_CAMPAIGN_SEED_BYTES) {
      throw new ArtifactTransportError(
        `Worker artifact ${wanted} is ${bytes.byteLength} bytes; the text transport limit is ${MAX_CAMPAIGN_SEED_BYTES}.`,
        "too_many_bytes",
      );
    }
    const text = decodeText(bytes, `Worker artifact ${wanted}`);
    return this.storeText(namespace, wanted, this.redact(text));
  }

  private async readLocalTaskArtifact(
    expectedWorkspace: string,
    claimedPath: string,
  ): Promise<Buffer> {
    let workspaceReal: string;
    try {
      workspaceReal = await realpath(expectedWorkspace);
    } catch (error) {
      // Deliberately not "missing". A vanished workspace is a broken collection,
      // and a caller that tolerates an absent file must not read it as one.
      throw new ArtifactTransportError(
        "Local task workspace is unavailable.",
        "transport_unavailable",
        { cause: error },
      );
    }
    const candidate = path.resolve(expectedWorkspace, ...claimedPath.split("/"));
    if (!inside(expectedWorkspace, candidate)) {
      throw new ArtifactTransportError(
        `Worker artifact ${claimedPath} escapes its task workspace.`,
        "invalid_path",
      );
    }
    let stats;
    try {
      stats = await lstat(candidate);
    } catch (error) {
      throw new ArtifactTransportError(
        `Worker artifact ${claimedPath} does not exist.`,
        "missing",
        { cause: error },
      );
    }
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new ArtifactTransportError(
        `Worker artifact ${claimedPath} must be a regular, non-symlink file.`,
        "not_regular",
      );
    }
    const candidateReal = await realpath(candidate);
    if (!inside(workspaceReal, candidateReal)) {
      throw new ArtifactTransportError(
        `Worker artifact ${claimedPath} resolves outside its task workspace.`,
        "invalid_path",
      );
    }
    return readFile(candidateReal);
  }

  private async readVerified(ref: ArtifactRef): Promise<Buffer> {
    const filename = this.resolveArtifactPath(ref.path);
    let bytes: Buffer;
    try {
      bytes = await readFile(filename);
    } catch (error) {
      throw new ArtifactTransportError(`Campaign artifact ${ref.path} is unavailable.`, "missing", {
        cause: error,
      });
    }
    const actual = sha256(bytes);
    if (actual !== ref.sha256) {
      throw new ArtifactTransportError(
        `Campaign artifact ${ref.path} failed its SHA-256 integrity check.`,
        "hash_mismatch",
      );
    }
    return bytes;
  }

  private resolveArtifactPath(relativePath: string): string {
    const portable = portableRelative(relativePath, "Campaign artifact path");
    const resolved = path.resolve(this.rootDir, ...portable.split("/"));
    if (!inside(this.rootDir, resolved)) {
      throw new ArtifactTransportError(
        `Campaign artifact path ${relativePath} escapes ${this.rootDir}.`,
        "invalid_path",
      );
    }
    return resolved;
  }
}

export function assertSeedFileLimits(files: Readonly<Record<string, string>>): void {
  const entries = Object.entries(files);
  if (entries.length === 0 || entries.length > MAX_CAMPAIGN_SEED_FILES) {
    throw new ArtifactTransportError(
      `A Ling task must receive between 1 and ${MAX_CAMPAIGN_SEED_FILES} seeded files; got ${entries.length}.`,
      "too_many_files",
    );
  }
  let totalBytes = 0;
  for (const [filename, content] of entries) {
    portableRelative(filename, "Seeded file");
    if (filename.length > MAX_CAMPAIGN_SEED_PATH_CHARS) {
      throw new ArtifactTransportError(
        `Seeded file path ${JSON.stringify(filename)} is ${filename.length} characters; Ling accepts at most ${MAX_CAMPAIGN_SEED_PATH_CHARS}.`,
        "invalid_path",
      );
    }
    totalBytes += Buffer.byteLength(content);
  }
  if (totalBytes > MAX_CAMPAIGN_SEED_BYTES) {
    throw new ArtifactTransportError(
      `Seeded files total ${totalBytes} bytes; Ling accepts at most ${MAX_CAMPAIGN_SEED_BYTES}.`,
      "too_many_bytes",
    );
  }
}

import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assertCampaignTransition,
  assertSliceTransition,
  parseCampaignManifest,
  type CampaignManifest,
  type CampaignStatus,
  type SliceStatus,
} from "./schema.js";

export type ManifestMutation = (manifest: CampaignManifest) => void | Promise<void>;

export class ManifestConcurrentModificationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ManifestConcurrentModificationError";
  }
}

export class CampaignManifestStore {
  readonly filename: string;

  constructor(filename: string) {
    this.filename = path.resolve(filename);
  }

  async load(): Promise<CampaignManifest> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.filename, "utf8"));
    } catch (error) {
      throw new Error(`Unable to read campaign manifest ${this.filename}.`, { cause: error });
    }
    return parseCampaignManifest(parsed);
  }

  async create(manifest: CampaignManifest): Promise<CampaignManifest> {
    const validated = parseCampaignManifest(manifest);
    await writeJsonAtomic(this.filename, validated, true);
    return validated;
  }

  async save(manifest: CampaignManifest): Promise<CampaignManifest> {
    return this.withWriteLock(async () => {
      const current = await this.load();
      if (current.updatedAt !== manifest.updatedAt) {
        throw new ManifestConcurrentModificationError(
          `Campaign manifest changed since ${manifest.updatedAt}; refusing to overwrite ${current.updatedAt}.`,
        );
      }
      const now = Date.now();
      const prior = Date.parse(current.updatedAt);
      const candidate = {
        ...manifest,
        updatedAt: new Date(Math.max(now, prior + 1)).toISOString(),
      };
      const validated = parseCampaignManifest(candidate);
      await writeJsonAtomic(this.filename, validated, false);
      return validated;
    });
  }

  async update(mutate: ManifestMutation): Promise<CampaignManifest> {
    const current = await this.load();
    const candidate = structuredClone(current);
    await mutate(candidate);
    return this.save(candidate);
  }

  private async withWriteLock<T>(run: () => Promise<T>): Promise<T> {
    const lockPath = `${this.filename}.write-lock`;
    let lock: Awaited<ReturnType<typeof open>> | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        lock = await open(lockPath, "wx", 0o600);
        await lock.writeFile(
          `${JSON.stringify({
            pid: process.pid,
            hostname: os.hostname(),
            startedAt: new Date().toISOString(),
          })}\n`,
          "utf8",
        );
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw new ManifestConcurrentModificationError(
            `Unable to lock campaign manifest ${this.filename}.`,
            { cause: error },
          );
        }
        const stale = await this.writeLockIsStale(lockPath);
        if (!stale || attempt > 0) {
          throw new ManifestConcurrentModificationError(
            `Another writer is updating campaign manifest ${this.filename}.`,
            { cause: error },
          );
        }
        await rm(lockPath, { force: true });
      }
    }
    if (lock === undefined) {
      throw new ManifestConcurrentModificationError(
        `Unable to lock campaign manifest ${this.filename}.`,
      );
    }
    try {
      return await run();
    } finally {
      await lock.close();
      await rm(lockPath, { force: true });
    }
  }

  private async writeLockIsStale(lockPath: string): Promise<boolean> {
    try {
      const owner = JSON.parse(await readFile(lockPath, "utf8")) as {
        pid?: number;
        hostname?: string;
      };
      if (
        owner.hostname === os.hostname() &&
        Number.isInteger(owner.pid) &&
        owner.pid !== undefined
      ) {
        try {
          process.kill(owner.pid, 0);
          return false;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code !== "EPERM";
        }
      }
    } catch {
      // Fall through to age-based recovery for malformed/remote locks.
    }
    return Date.now() - (await stat(lockPath)).mtimeMs > 5 * 60 * 1000;
  }
}

export function transitionCampaign(manifest: CampaignManifest, next: CampaignStatus): void {
  assertCampaignTransition(manifest.status, next);
  manifest.status = next;
}

export function transitionSlice(
  manifest: CampaignManifest,
  sliceId: string,
  next: SliceStatus,
): void {
  const slice = manifest.slices.find((candidate) => candidate.id === sliceId);
  if (slice === undefined) throw new Error(`Unknown campaign slice ${JSON.stringify(sliceId)}.`);
  assertSliceTransition(slice.status, next);
  slice.status = next;
}

async function writeJsonAtomic(
  filename: string,
  value: unknown,
  exclusive: boolean,
): Promise<void> {
  const directory = path.dirname(filename);
  await mkdir(directory, { recursive: true });
  const temporary = path.join(
    directory,
    `.${path.basename(filename)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }

  if (exclusive) {
    try {
      await link(temporary, filename);
      await rm(temporary);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw new Error(`Unable to create campaign manifest ${filename}.`, { cause: error });
    }
    return;
  }

  try {
    await renameWithRetry(temporary, filename);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw new Error(`Unable to replace campaign manifest ${filename} atomically.`, { cause: error });
  }
}

/**
 * How long a refused rename over the manifest is retried.
 *
 * On Windows a rename onto a file another handle has open fails with EPERM,
 * EACCES or EBUSY until that handle closes, and anything may be reading the
 * manifest: a status command, the reaper, the stall check, a scanner. A read
 * holds it for milliseconds, but a reader that polls can meet retry after
 * retry. Five attempts within about 100 ms were not enough beside one that
 * read every 2 ms, and a writer that gives up fails the run with its workers
 * still spending. So on Windows the retries go on far longer than any read
 * takes, and still end: a file held for all of it is held by something that
 * will not let go. Elsewhere a reader does not refuse a rename, and only
 * EBUSY is retried, as briefly as before, since there it is more often a
 * mount point that stays busy.
 */
const RENAME_RETRY_MS = process.platform === "win32" ? 10_000 : 100;

async function renameWithRetry(source: string, destination: string): Promise<void> {
  const deadline = Date.now() + RENAME_RETRY_MS;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        (process.platform !== "win32" && code !== "EBUSY") ||
        !["EPERM", "EACCES", "EBUSY"].includes(code ?? "") ||
        Date.now() >= deadline
      ) {
        throw error;
      }
      // Up to 100 ms apart, and jittered: a reader polling on the same timer
      // tick as a fixed schedule can be the first to the file every time.
      const delay = Math.min(100, attempt * 10) * (0.5 + Math.random());
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(delay, Math.max(0, deadline - Date.now()))),
      );
    }
  }
}

import { randomUUID } from "node:crypto";
import { open, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

interface LockMetadata {
  token: string;
  pid: number;
  hostname: string;
  startedAt: string;
}

export interface CampaignLock {
  readonly filename: string;
  assertOwned(): Promise<void>;
  release(): Promise<void>;
}

export class CampaignLockError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CampaignLockError";
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function stale(
  filename: string,
  staleMs: number,
): Promise<{ stale: boolean; owner?: LockMetadata }> {
  let owner: LockMetadata | undefined;
  try {
    owner = JSON.parse(await readFile(filename, "utf8")) as LockMetadata;
  } catch {
    // A partial lock is stale only after the same age fallback as a remote lock.
  }
  if (
    owner !== undefined &&
    owner.hostname === os.hostname() &&
    Number.isInteger(owner.pid) &&
    !processAlive(owner.pid)
  ) {
    return { stale: true, owner };
  }
  const age = Date.now() - (await stat(filename)).mtimeMs;
  return { stale: age > staleMs, ...(owner === undefined ? {} : { owner }) };
}

async function sameOwner(filename: string, token: string): Promise<boolean> {
  try {
    const owner = JSON.parse(await readFile(filename, "utf8")) as LockMetadata;
    return owner.token === token;
  } catch {
    return false;
  }
}

async function recoverStaleLock(filename: string, staleMs: number): Promise<boolean> {
  const recoveryPath = `${filename}.recovery`;
  let recovery;
  try {
    recovery = await open(recoveryPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const age = Date.now() - (await stat(recoveryPath)).mtimeMs;
    if (age > staleMs) await rm(recoveryPath, { force: true });
    return false;
  }
  try {
    const current = await stale(filename, staleMs).catch(() => ({ stale: false }));
    if (!current.stale) return false;
    await rm(filename);
    return true;
  } finally {
    await recovery.close();
    await rm(recoveryPath, { force: true });
  }
}

export async function acquireCampaignLock(
  campaignDirectory: string,
  staleMs = Number.parseInt(process.env["CAMPAIGN_LOCK_STALE_MS"] ?? "", 10) ||
    24 * 60 * 60 * 1000,
): Promise<CampaignLock> {
  const filename = path.join(path.resolve(campaignDirectory), ".campaign-run.lock");
  const metadata: LockMetadata = {
    token: randomUUID(),
    pid: process.pid,
    hostname: os.hostname(),
    startedAt: new Date().toISOString(),
  };

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const file = await open(filename, "wx", 0o600);
      await file.writeFile(`${JSON.stringify(metadata)}\n`, "utf8");
      await file.sync();
      let released = false;
      let lost = false;
      let renewal: Promise<void> = Promise.resolve();
      const renewEveryMs = Math.max(10, Math.min(60_000, Math.floor(staleMs / 3)));
      const renew = async () => {
        if (released || lost) return;
        if (!(await sameOwner(filename, metadata.token))) {
          lost = true;
          return;
        }
        const now = new Date();
        await file.utimes(now, now);
        if (!(await sameOwner(filename, metadata.token))) lost = true;
      };
      const renewalTimer = setInterval(() => {
        renewal = renewal.then(renew).catch(() => {
          lost = true;
        });
      }, renewEveryMs);
      renewalTimer.unref();
      return {
        filename,
        assertOwned: async () => {
          await renewal;
          if (lost || !(await sameOwner(filename, metadata.token))) {
            throw new CampaignLockError("Campaign lock ownership was lost.");
          }
        },
        release: async () => {
          if (released) return;
          released = true;
          clearInterval(renewalTimer);
          await renewal;
          await file.close();
          if (await sameOwner(filename, metadata.token)) await rm(filename, { force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new CampaignLockError(`Unable to lock campaign directory ${campaignDirectory}.`, {
          cause: error,
        });
      }
      const existing: { stale: boolean; owner?: LockMetadata } = await stale(
        filename,
        staleMs,
      ).catch(() => ({ stale: false }));
      if (!existing.stale) {
        const detail =
          existing.owner === undefined
            ? ""
            : ` (pid ${existing.owner.pid} on ${existing.owner.hostname}, since ${existing.owner.startedAt})`;
        throw new CampaignLockError(`Campaign is already running${detail}.`);
      }
      if (!(await recoverStaleLock(filename, staleMs))) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }
  throw new CampaignLockError("Unable to acquire campaign lock.");
}

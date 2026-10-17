import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_OBJECTIVE_LIMITS,
  OBJECTIVE_VERSION,
  charterAddress,
  chunkAddress,
  parseObjectiveManifest,
  parseProductSnapshotPointer,
  type ObjectiveAssessment,
  type ObjectiveBudget,
  type ObjectiveCharter,
  type ObjectiveChunkRecord,
  type ObjectiveHalt,
  type ObjectiveLimits,
  type ObjectiveManifest,
  type ProductSnapshotPointer,
} from "./schema.js";

export type ObjectiveManifestMutation = (
  manifest: ObjectiveManifest,
) => void | Promise<void>;

export class ObjectiveConcurrentModificationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ObjectiveConcurrentModificationError";
  }
}

/**
 * A write that was internally consistent and still not allowed: rewriting recorded
 * history, editing the charter outside a reform, or doing more work after halting.
 *
 * Separate from `ObjectiveConcurrentModificationError` because the two mean different
 * things to a caller. A concurrent modification says *try again with fresh state*; an
 * invariant violation says *this write was never going to be legal*, and retrying it
 * is how a loop spins.
 */
export class ObjectiveInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObjectiveInvariantError";
  }
}

/** What a caller supplies to append a finished chunk. Index and address are derived. */
export type ObjectiveChunkInput = Omit<ObjectiveChunkRecord, "index" | "chunkId">;

/** What a caller supplies to start an objective. Revision and creation time are derived. */
export interface ObjectiveCharterInput {
  statement: string;
  budget: ObjectiveBudget;
  limits?: ObjectiveLimits;
  constraints?: readonly string[];
}

export interface ObjectiveHaltInput {
  reportId: string;
  summary: string;
  at?: string;
}

export interface ObjectiveReformInput {
  /** The report the principal's reply answers. A reform with no report is not a reply. */
  reportId: string;
  note: string;
  at?: string;
}

interface CommitOptions {
  /** Only `reformCharter` sets this, and only after checking the authorization. */
  allowCharterChange?: boolean;
  /** Set by the three operations that own the halt: record, mark sent, and reform. */
  allowHaltChange?: boolean;
}

export class ObjectiveManifestStore {
  readonly filename: string;

  constructor(filename: string) {
    this.filename = path.resolve(filename);
  }

  async load(): Promise<ObjectiveManifest> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readWithRetry(this.filename));
    } catch (error) {
      throw new Error(`Unable to read objective manifest ${this.filename}.`, { cause: error });
    }
    return parseObjectiveManifest(parsed);
  }

  async create(manifest: ObjectiveManifest): Promise<ObjectiveManifest> {
    const validated = parseObjectiveManifest(manifest);
    await writeJsonAtomic(this.filename, validated, true);
    return validated;
  }

  async save(manifest: ObjectiveManifest): Promise<ObjectiveManifest> {
    const supplied = parseObjectiveManifest(manifest);
    return this.withWriteLock(async () => {
      const current = await this.load();
      this.assertUnchangedSince(current, supplied, "refusing to overwrite");
      return this.commit(current, supplied, {});
    });
  }

  async update(mutate: ObjectiveManifestMutation): Promise<ObjectiveManifest> {
    const current = await this.load();
    const candidate = structuredClone(current);
    await mutate(candidate);
    return this.save(candidate);
  }

  async compareAndSwapProductSnapshot(
    expected: ObjectiveManifest,
    next: ProductSnapshotPointer,
  ): Promise<ObjectiveManifest> {
    const supplied = parseObjectiveManifest(expected);
    const parsedNext = parseProductSnapshotPointer(next);
    return this.withWriteLock(async () => {
      const current = await this.load();
      this.assertUnchangedSince(current, supplied, "refusing to replace its product snapshot");
      if (!sameProductSnapshot(current.currentProductSnapshot, supplied.currentProductSnapshot)) {
        throw new ObjectiveConcurrentModificationError(
          "Objective product snapshot changed from the caller's expected pointer.",
        );
      }
      return this.commit(current, { ...current, currentProductSnapshot: parsedNext }, {});
    });
  }

  /**
   * Append a finished chunk.
   *
   * The index and the content address are computed here rather than accepted, because
   * both are what later reads rely on: a caller-supplied index can leave a gap that
   * looks like a lost append, and a caller-supplied address could name a different
   * chunk than the one recorded beside it, which would quietly defeat the check that
   * the loop is not retrying the same failing chunk.
   */
  async appendChunk(
    expected: ObjectiveManifest,
    chunk: ObjectiveChunkInput,
  ): Promise<ObjectiveManifest> {
    const supplied = parseObjectiveManifest(expected);
    return this.withWriteLock(async () => {
      const current = await this.load();
      this.assertUnchangedSince(current, supplied, "refusing to append a chunk");
      // Derived fields last, so a caller reaching past the type to supply its own
      // index or address overrides nothing.
      const record: ObjectiveChunkRecord = {
        ...chunk,
        index: current.chunks.length + 1,
        chunkId: chunkAddress(chunk.statement, chunk.criteria),
      };
      return this.commit(current, { ...current, chunks: [...current.chunks, record] }, {});
    });
  }

  async appendAssessment(
    expected: ObjectiveManifest,
    assessment: ObjectiveAssessment,
  ): Promise<ObjectiveManifest> {
    const supplied = parseObjectiveManifest(expected);
    return this.withWriteLock(async () => {
      const current = await this.load();
      this.assertUnchangedSince(current, supplied, "refusing to append an assessment");
      return this.commit(
        current,
        { ...current, assessments: [...current.assessments, assessment] },
        {},
      );
    });
  }

  /**
   * Halt the objective, holding the report that justifies it.
   *
   * The report enters `unsent`: composing it and delivering it are separate acts, and
   * until the human-contact ling tool exists the second one cannot happen at all. An
   * overlord that has halted holding an unsent report is in a real, recorded state
   * rather than an undocumented one.
   */
  async recordHalt(
    expected: ObjectiveManifest,
    halt: ObjectiveHaltInput,
  ): Promise<ObjectiveManifest> {
    const supplied = parseObjectiveManifest(expected);
    return this.withWriteLock(async () => {
      const current = await this.load();
      this.assertUnchangedSince(current, supplied, "refusing to halt it");
      if (current.halt !== null) {
        throw new ObjectiveInvariantError(
          `Objective ${current.id} has already halted on report ${current.halt.reportId}; a second halt would discard the report the principal is answering.`,
        );
      }
      return this.commit(
        current,
        {
          ...current,
          halt: {
            at: halt.at ?? new Date().toISOString(),
            reportId: halt.reportId,
            summary: halt.summary,
            delivery: "unsent",
            awaitingReply: false,
          },
        },
        { allowHaltChange: true },
      );
    });
  }

  /** Record that the ling delivered the report, which is when a reply becomes possible. */
  async markReportSent(expected: ObjectiveManifest): Promise<ObjectiveManifest> {
    const supplied = parseObjectiveManifest(expected);
    return this.withWriteLock(async () => {
      const current = await this.load();
      this.assertUnchangedSince(current, supplied, "refusing to mark its report sent");
      if (current.halt === null) {
        throw new ObjectiveInvariantError(
          `Objective ${current.id} has not halted, so it holds no report to send.`,
        );
      }
      return this.commit(
        current,
        { ...current, halt: { ...current.halt, delivery: "sent", awaitingReply: true } },
        { allowHaltChange: true },
      );
    });
  }

  /**
   * Re-form the objective on the principal's reply, and resume.
   *
   * This is the only path that may change the charter, and it is gated on the report
   * the reply answers, so a changed goal always has a recorded cause. The reply is
   * authoritative about *what* the objective now is; it is not authority this store
   * can verify, which is the inbound channel's job. What this enforces is narrower and
   * still worth having: no charter change without a halt, without the matching report
   * id, and without a reform entry naming the charter it replaced.
   */
  async reformCharter(
    expected: ObjectiveManifest,
    charter: ObjectiveCharterInput,
    reform: ObjectiveReformInput,
  ): Promise<ObjectiveManifest> {
    const supplied = parseObjectiveManifest(expected);
    return this.withWriteLock(async () => {
      const current = await this.load();
      this.assertUnchangedSince(current, supplied, "refusing to re-form it");
      if (current.halt === null) {
        throw new ObjectiveInvariantError(
          `Objective ${current.id} has not halted, so there is no reply to re-form it.`,
        );
      }
      if (current.halt.reportId !== reform.reportId) {
        throw new ObjectiveInvariantError(
          `Reform cites report ${reform.reportId} but objective ${current.id} halted on ${current.halt.reportId}; a reply may only re-form the objective it was sent about.`,
        );
      }
      const next: ObjectiveManifest = {
        ...current,
        charter: {
          revision: current.charter.revision + 1,
          statement: charter.statement,
          budget: charter.budget,
          limits: charter.limits ?? current.charter.limits,
          constraints: [...(charter.constraints ?? current.charter.constraints)],
          createdAt: current.charter.createdAt,
        },
        reforms: [
          ...current.reforms,
          {
            at: reform.at ?? new Date().toISOString(),
            reportId: reform.reportId,
            priorCharterRevision: current.charter.revision,
            priorCharterAddress: charterAddress(current.charter),
            note: reform.note,
          },
        ],
        halt: null,
      };
      return this.commit(current, next, { allowCharterChange: true, allowHaltChange: true });
    });
  }

  private assertUnchangedSince(
    current: ObjectiveManifest,
    supplied: ObjectiveManifest,
    refusal: string,
  ): void {
    if (current.updatedAt !== supplied.updatedAt) {
      throw new ObjectiveConcurrentModificationError(
        `Objective manifest changed since ${supplied.updatedAt}; ${refusal} at ${current.updatedAt}.`,
      );
    }
    if (current.id !== supplied.id) {
      throw new ObjectiveConcurrentModificationError(
        `Objective identity changed from ${JSON.stringify(supplied.id)} to ${JSON.stringify(current.id)}.`,
      );
    }
  }

  /**
   * Validate the candidate against what it is replacing, stamp a later `updatedAt`,
   * and write it atomically. Every mutating path goes through here, so the invariants
   * below hold for all of them rather than for the ones that remembered.
   */
  private async commit(
    current: ObjectiveManifest,
    candidate: ObjectiveManifest,
    options: CommitOptions,
  ): Promise<ObjectiveManifest> {
    assertSuccession(current, candidate, options);
    const now = Date.now();
    const prior = Date.parse(current.updatedAt);
    const validated = parseObjectiveManifest({
      ...candidate,
      updatedAt: new Date(Math.max(now, prior + 1)).toISOString(),
    });
    await writeJsonAtomic(this.filename, validated, false);
    return validated;
  }

  private async withWriteLock<T>(run: () => Promise<T>): Promise<T> {
    const lockPath = `${this.filename}.write-lock`;
    let lock: Awaited<ReturnType<typeof open>> | undefined;
    // Patient rather than immediate. The lock exists to stop a second *overlord*, so
    // contention is rare by design — but a reader or an operator script colliding with
    // a write is ordinary, and bouncing the caller out after two tries turns that into
    // a failure it has to handle. Waiting here instead is the same trade SQLite makes
    // with `busy_timeout`, and it keeps a herd of retrying callers from amplifying.
    for (let attempt = 0; attempt < LOCK_ATTEMPTS && lock === undefined; attempt += 1) {
      if (attempt > 0) await backoff(attempt);
      let opened: Awaited<ReturnType<typeof open>> | undefined;
      try {
        opened = await open(lockPath, "wx", 0o600);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? "";
        // `open` failed, so this file is not ours, and the one thing never to do with
        // another writer's lock is delete it. This branch used to unlink on any code
        // other than EEXIST, which looked like tidying up after itself and was not:
        // Windows reports an existing lock as EPERM or EACCES rather than EEXIST when
        // it is held or pending deletion, so a writer that lost the race would remove
        // the winner's lock and let a third writer in beside it. Under twelve writers
        // that silently lost roughly a third of all appends.
        if (code !== "EEXIST" && !SHARING_VIOLATION_CODES.has(code)) {
          throw new ObjectiveConcurrentModificationError(
            `Unable to lock objective manifest ${this.filename}.`,
            { cause: error },
          );
        }
        const verdict = await this.inspectWriteLock(lockPath);
        // Released and held are handled identically — wait and try again — so the
        // distinction buys latency, not safety. What matters is that neither deletes
        // anything: only `stale` licenses that, and a mutation that unlinks on `held`
        // is caught by the concurrency checks. Unlinking on `released` is a narrower
        // race the suite cannot reliably provoke, since the file is usually already
        // gone by then, so the rule is kept by construction rather than by test.
        if (verdict === "released") continue;
        if (verdict === "held") continue;
        // Recovering an aged lock unlinks a file this process did not create, so do it
        // once per call and never as a reflex on a later attempt.
        if (attempt > 0) continue;
        await rm(lockPath, { force: true });
        continue;
      }
      try {
        await opened.writeFile(
          `${JSON.stringify({
            pid: process.pid,
            hostname: os.hostname(),
            startedAt: new Date().toISOString(),
          })}\n`,
          "utf8",
        );
        await opened.sync();
        lock = opened;
      } catch (error) {
        // This file *is* ours, so cleaning it up is right here: a lock we created but
        // could not stamp would otherwise block the objective until it aged out.
        await opened.close().catch(() => undefined);
        await rm(lockPath, { force: true }).catch(() => undefined);
        throw new ObjectiveConcurrentModificationError(
          `Unable to lock objective manifest ${this.filename}.`,
          { cause: error },
        );
      }
    }
    if (lock === undefined) {
      throw new ObjectiveConcurrentModificationError(
        `Unable to lock objective manifest ${this.filename}.`,
      );
    }
    try {
      return await run();
    } finally {
      await lock.close();
      await rm(lockPath, { force: true });
    }
  }

  /**
   * Why three answers and not two.
   *
   * `held` and `stale` are the interesting pair, but a lock can also simply be *gone*
   * by the time it is examined, and the three must be distinguished because only
   * `stale` licenses deleting the file. Collapsing `released` into `stale` looks
   * harmless and is not: between noticing the file had vanished and unlinking it,
   * another writer will have created its own, and unlinking that puts two writers
   * inside the critical section at once. It shows up as a lost append rather than as
   * an error, which is the worst way for a lock to fail.
   *
   * The residual hazard, stated rather than hidden: recovering a genuinely aged lock
   * still unlinks a file this process did not create, so an owner that was merely
   * stalled for five minutes can have its lock removed underneath it. That is inherent
   * to recovering lock files by unlinking, and the alternative — never recovering —
   * means one crashed overlord blocks its objective forever.
   */
  private async inspectWriteLock(lockPath: string): Promise<"held" | "stale" | "released"> {
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
          return "held";
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === "EPERM" ? "held" : "stale";
        }
      }
    } catch {
      // Fall through to age-based recovery for malformed or remote locks. An empty
      // file is one of these: a holder that has opened its lock but not yet written
      // it, which is fresh and therefore held.
    }
    try {
      return Date.now() - (await stat(lockPath)).mtimeMs > 5 * 60 * 1000 ? "stale" : "held";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "released";
      return "held";
    }
  }
}

/**
 * The three rules that make the record worth reading, checked on every write.
 *
 * **History only extends.** Chunks, assessments and reforms may gain entries and may
 * not lose or alter one. The viability argument rests entirely on the assessment
 * series being a history rather than a current opinion — an estimate that declined
 * slowly across forty cycles means something a rewritten series cannot mean — and a
 * chunk history that can be edited cannot show the loop retried a failing chunk.
 *
 * **The charter does not drift.** Only `reformCharter` may touch it. The failure this
 * prevents is the one the roadmap calls worse than halting too eagerly: an overlord
 * that quietly narrows the objective to whatever it can still afford and reports
 * success on the smaller thing.
 *
 * **A halted objective does no more work.** While a halt stands, nothing may be
 * appended. Halting is supposed to stop spending against the principal's silence, and
 * a halt that still accepted chunks would be a halt in name.
 */
function assertSuccession(
  current: ObjectiveManifest,
  candidate: ObjectiveManifest,
  options: CommitOptions,
): void {
  assertAppendOnly(current.chunks, candidate.chunks, "chunks");
  assertAppendOnly(current.assessments, candidate.assessments, "assessments");
  assertAppendOnly(current.reforms, candidate.reforms, "reforms");
  if (options.allowCharterChange !== true) {
    if (charterAddress(current.charter) !== charterAddress(candidate.charter)) {
      throw new ObjectiveInvariantError(
        `Objective ${current.id} charter may only change through a recorded reform.`,
      );
    }
  }
  // The halt itself is only a capability of the operations that own it. Guarding
  // *appends while halted* was not enough: a single ordinary `save` could clear the
  // halt and append in one write, or swap the report the principal is answering, and
  // both passed. Lifting a halt is `reformCharter`'s job, because that is the path that
  // demands the report id and records what changed.
  if (options.allowHaltChange !== true && !sameHalt(current.halt, candidate.halt)) {
    throw new ObjectiveInvariantError(
      `Objective ${current.id} halt may only change through recordHalt, markReportSent, or reformCharter.`,
    );
  }
  const appended =
    candidate.chunks.length > current.chunks.length ||
    candidate.assessments.length > current.assessments.length;
  if (current.halt !== null && candidate.halt !== null && appended) {
    throw new ObjectiveInvariantError(
      `Objective ${current.id} halted on report ${current.halt.reportId}; it may record no further work until that halt is lifted.`,
    );
  }
}

function sameHalt(left: ObjectiveHalt | null, right: ObjectiveHalt | null): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.at === right.at &&
    left.reportId === right.reportId &&
    left.summary === right.summary &&
    left.delivery === right.delivery &&
    left.awaitingReply === right.awaitingReply
  );
}

/**
 * Compared as encoded JSON because both sides are produced by
 * `parseObjectiveManifest`, which builds every entry with a fixed field order. That
 * makes encoding a faithful identity test here and would not for hand-built objects,
 * which is why nothing outside this module is asked to compare entries this way.
 */
function assertAppendOnly(
  current: readonly unknown[],
  candidate: readonly unknown[],
  field: string,
): void {
  if (candidate.length < current.length) {
    throw new ObjectiveInvariantError(
      `Objective ${field} may only be appended to; the write drops ${current.length - candidate.length} recorded entry(s).`,
    );
  }
  for (let index = 0; index < current.length; index += 1) {
    if (JSON.stringify(candidate[index]) !== JSON.stringify(current[index])) {
      throw new ObjectiveInvariantError(
        `Objective ${field}[${index}] is already recorded and may not be rewritten.`,
      );
    }
  }
}

function sameProductSnapshot(
  left: ProductSnapshotPointer | null,
  right: ProductSnapshotPointer | null,
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.snapshotId === right.snapshotId &&
      left.path === right.path &&
      left.sha256 === right.sha256)
  );
}

export async function initializeObjective(
  store: ObjectiveManifestStore,
  input: { id: string; charter: ObjectiveCharterInput },
  now: Date = new Date(),
): Promise<ObjectiveManifest> {
  const createdAt = now.toISOString();
  const charter: ObjectiveCharter = {
    revision: 1,
    statement: input.charter.statement,
    budget: input.charter.budget,
    limits: input.charter.limits ?? DEFAULT_OBJECTIVE_LIMITS,
    constraints: [...(input.charter.constraints ?? [])],
    createdAt,
  };
  return store.create(
    parseObjectiveManifest({
      version: OBJECTIVE_VERSION,
      id: input.id,
      charter,
      currentProductSnapshot: null,
      chunks: [],
      assessments: [],
      reforms: [],
      halt: null,
      updatedAt: createdAt,
    }),
  );
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
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(temporary, "wx", 0o600);
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await file.sync();
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw new Error(`Unable to stage objective manifest ${filename}.`, { cause: error });
  } finally {
    await file?.close();
  }

  if (exclusive) {
    try {
      await link(temporary, filename);
      await rm(temporary);
      await syncDirectory(directory);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw new Error(`Unable to create objective manifest ${filename}.`, { cause: error });
    }
    return;
  }

  try {
    await renameWithRetry(temporary, filename);
    await syncDirectory(directory);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    // A reader holding the file open is ordinary operation, not a broken disk: an
    // operator tailing the record, or another writer's `load` in the moment before it
    // discovers it lost the race. Report it as the retryable thing it is, so a caller
    // that already knows how to refresh and try again does not have to distinguish
    // this from a permissions failure by reading a message.
    if (isSharingViolation(error)) {
      throw new ObjectiveConcurrentModificationError(
        `Objective manifest ${filename} was held open by another reader or writer; the write did not land.`,
        { cause: error },
      );
    }
    throw new Error(`Unable to replace objective manifest ${filename} atomically.`, {
      cause: error,
    });
  }
}

/**
 * Windows refuses to replace or open a file another handle holds, and both sides of
 * this store race by design: writers serialize through the lock, but readers do not
 * take it at all, because a record meant to be read by an operator mid-run cannot
 * require one.
 *
 * Honest note on coverage. This path and `readWithRetry` are the reason the very first
 * twelve-writer run failed with a bare "could not replace atomically", so they are not
 * theoretical. But once the lock stopped being stealable, writers stopped colliding
 * often enough for the checks to provoke either path again: mutating both away leaves
 * the suite green on this machine. They stay because how long a handle lingers is a
 * property of the filesystem and whatever scanner is watching it, not of this code,
 * and the failure they prevent is a legal write reported as a broken disk.
 */
const SHARING_VIOLATION_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

function isSharingViolation(error: unknown): boolean {
  return SHARING_VIOLATION_CODES.has((error as NodeJS.ErrnoException).code ?? "");
}

async function backoff(attempt: number): Promise<void> {
  // Jittered, so twelve writers that collide do not wake together and collide again.
  await new Promise((resolve) => setTimeout(resolve, attempt * 15 + Math.random() * 15));
}

/** About a second of patience in total, at `backoff`'s schedule. */
const LOCK_ATTEMPTS = 10;

/**
 * A read may lose the same race as a write. Retrying is bounded and short; a genuinely
 * missing or corrupt file still fails on the first attempt, because `ENOENT` is not a
 * sharing violation and there is nothing to wait for.
 */
async function readWithRetry(filename: string): Promise<string> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await readFile(filename, "utf8");
    } catch (error) {
      if (!isSharingViolation(error) || attempt >= 8) throw error;
      await backoff(attempt);
    }
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    // Windows does not consistently allow opening or fsyncing directory handles.
    if (process.platform !== "win32") throw error;
  } finally {
    await handle?.close();
  }
}

/**
 * Twelve attempts rather than five, because the old budget of 100ms was set against
 * one imagined reader and a dozen concurrent writers exhausted it. The exhausted case
 * is now reported as contention rather than as a failure, so this is a delay budget
 * and not the last line of defence.
 */
async function renameWithRetry(source: string, destination: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const transient =
        isSharingViolation(error) && (process.platform === "win32" || code === "EBUSY");
      if (!transient || attempt >= 12) throw error;
      await backoff(attempt);
    }
  }
}

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import {
  CampaignMessageValidationError,
  MAX_CAMPAIGN_CONTENT_CHARS,
  MAX_CAMPAIGN_MESSAGE_IDS,
  parseCampaignPeerMessage,
  type CampaignPeerMessage,
} from "../campaign.js";
import { config, type Config } from "../config.js";
import {
  SQLiteTaskStore,
  TaskQueue,
  TaskQueueShuttingDownError,
  type TaskOutcome,
  type TaskRecord,
} from "../queue.js";
import { TokenBucketRateLimiter } from "../rate-limit.js";
import {
  FINAL_STATE_CONTENT_BUDGET_BYTES,
  FINAL_STATE_MAX_CONTENT_BYTES,
  listTaskArtifacts,
  readTaskArtifact,
  readTaskFinalState,
  type TaskFinalState,
} from "../artifacts.js";
import { eventLogFile, pruneExpiredTasks } from "../retention.js";

// The API module starts the service when it is imported, unless told not to;
// it is imported here only to mount its final-state route on a queue of the
// check's own.
process.env["LING_SERVER_IMPORT_ONLY"] = "1";
const { createRequestListener } = await import("../server.js");

const root = await mkdtemp(path.join(os.tmpdir(), "ling-queue-check-"));
const dbPath = path.join(root, "tasks.db");
let failures = 0;

async function check(label: string, run: () => void | Promise<void>): Promise<void> {
  try {
    await run();
    console.log(`PASS  ${label}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${label} -- ${error instanceof Error ? error.message : String(error)}`);
  }
}

const outcome: TaskOutcome = {
  status: "completed",
  stoppedBy: "finished",
  result: { ok: true },
};

const sha256 = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** A terminal task over `workspace`, as readTaskFinalState is given one. */
function endedTask(id: string, workspace: string, seedFiles?: Record<string, string>): TaskRecord {
  return {
    id,
    createdBy: "check",
    prompt: "final state",
    status: "completed",
    createdAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    workspaceDir: workspace,
    ...(seedFiles === undefined ? {} : { seedFiles }),
    options: {},
    events: [],
  };
}

/**
 * A link at `link` to the file `target`: a file symlink where this platform
 * lets one be made, otherwise a junction to the file's directory. On Windows
 * a file symlink needs Developer Mode, and a junction is a link all the same,
 * one the record must not follow either.
 */
async function linkOut(target: string, link: string): Promise<string> {
  try {
    await symlink(target, link, "file");
    return "a file symlink";
  } catch (error) {
    if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    await symlink(path.dirname(target), link, "junction");
    return "a junction (file symlinks need Developer Mode here)";
  }
}

/** A link at `link` to the directory `target`. */
async function linkDirectory(target: string, link: string): Promise<void> {
  await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
}

/**
 * Take this user's read access to `target` away: chmod 000 on POSIX, and on
 * Windows an ACL entry that denies this user reading the file, or listing the
 * directory. Returns the undo, or why it could not be done, which is also the
 * answer when the target can still be read afterwards, as root reads through
 * a chmod.
 */
async function denyRead(
  target: string,
  kind: "file" | "directory",
): Promise<{ undo: () => Promise<void> } | { reason: string }> {
  let undo: () => Promise<void>;
  if (process.platform === "win32") {
    const domain = process.env["USERDOMAIN"];
    const user = process.env["USERNAME"];
    const account = domain && user ? `${domain}\\${user}` : os.userInfo().username;
    try {
      execFileSync("icacls", [target, "/deny", `${account}:${kind === "file" ? "(R)" : "(RD)"}`], { stdio: "ignore" });
    } catch (error) {
      return { reason: `icacls could not deny ${account} read: ${error instanceof Error ? error.message : String(error)}` };
    }
    undo = async () => {
      execFileSync("icacls", [target, "/remove:d", account], { stdio: "ignore" });
    };
  } else {
    await chmod(target, 0o000);
    undo = () => chmod(target, kind === "file" ? 0o600 : 0o700);
  }
  const readable = await (kind === "file" ? readFile(target) : readdir(target)).then(() => true, () => false);
  if (!readable) return { undo };
  await undo();
  return { reason: `${path.basename(target)} could still be read with its read access taken away` };
}

async function writeTree(base: string, files: Record<string, string | Uint8Array>): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(base, ...name.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

const depthThenPath = (left: string, right: string): number => {
  const depth = left.split("/").length - right.split("/").length;
  return depth !== 0 ? depth : left < right ? -1 : left > right ? 1 : 0;
};

try {
  await check("task creation rate limiter is caller-scoped and refills", () => {
    const limiter = new TokenBucketRateLimiter(60, 2);
    assert.equal(limiter.take("caller-a", 0).allowed, true);
    assert.equal(limiter.take("caller-a", 0).allowed, true);
    assert.equal(limiter.take("caller-a", 0).allowed, false);
    assert.equal(limiter.take("caller-b", 0).allowed, true);
    assert.equal(limiter.take("caller-a", 1_000).allowed, true);
    const bounded = new TokenBucketRateLimiter(60, 1, 2, 1_000);
    bounded.take("one", 1);
    bounded.take("two", 1);
    bounded.take("three", 1);
    assert.equal(bounded.size(), 2);
    bounded.take("fresh", 2_001);
    assert.equal(bounded.size(), 1);
  });

  await check("campaign message wire parser enforces exact bounded fields", () => {
    const message: CampaignPeerMessage = {
      id: "message-1",
      thread: "research",
      from: "peer-a",
      content: "A bounded peer update.",
      priority: "normal",
      sentAt: "2026-08-22T16:00:00.000Z",
    };
    assert.deepEqual(parseCampaignPeerMessage(message), message);
    assert.throws(
      () => parseCampaignPeerMessage({ ...message, extra: true }),
      CampaignMessageValidationError,
    );
    assert.throws(
      () =>
        parseCampaignPeerMessage({
          ...message,
          content: "x".repeat(MAX_CAMPAIGN_CONTENT_CHARS + 1),
        }),
      CampaignMessageValidationError,
    );
    assert.throws(
      () => parseCampaignPeerMessage({ ...message, sentAt: "tomorrow" }),
      CampaignMessageValidationError,
    );
  });

  await check("running campaign inbox buffers, deduplicates, bounds, and closes", async () => {
    const store = new SQLiteTaskStore(path.join(root, "campaign-inbox.db"));
    let allowSubscribe!: () => void;
    let releaseRunner!: () => void;
    let subscribed!: () => void;
    const subscribeGate = new Promise<void>((resolve) => {
      allowSubscribe = resolve;
    });
    const releaseGate = new Promise<void>((resolve) => {
      releaseRunner = resolve;
    });
    const subscribedGate = new Promise<void>((resolve) => {
      subscribed = resolve;
    });
    const received: CampaignPeerMessage[] = [];
    let unsubscribe: (() => void) | undefined;
    const queue = new TaskQueue({
      store,
      concurrency: 1,
      workspaceDirFor: (id) => path.join(root, id),
      runner: async (_task, _signal, _emit, messages) => {
        await subscribeGate;
        unsubscribe = messages.subscribe((message) => received.push(message));
        subscribed();
        await releaseGate;
        unsubscribe();
        return outcome;
      },
    });
    const task = queue.enqueue({
      createdBy: "check",
      prompt: "campaign radio",
      options: { tools: ["campaign_send"] },
    });
    const message = (index: number): CampaignPeerMessage => ({
      id: `message-${index}`,
      thread: "research",
      from: "peer-a",
      content: `Update ${index}`,
      priority: index % 2 === 0 ? "normal" : "fyi",
      sentAt: "2026-08-22T16:00:00.000Z",
    });

    try {
      while (store.get(task.id)?.status === "queued") {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      assert.deepEqual(queue.injectCampaignMessage(task.id, message(0)), {
        status: "accepted",
      });
      assert.deepEqual(queue.injectCampaignMessage(task.id, message(0)), {
        status: "duplicate",
      });
      assert.deepEqual(
        queue.injectCampaignMessage(task.id, {
          ...message(0),
          content: "Conflicting payload for the same id",
        }),
        { status: "id_conflict" },
      );
      assert.equal(received.length, 0);

      allowSubscribe();
      await subscribedGate;
      assert.deepEqual(received, [message(0)]);

      for (let index = 1; index < MAX_CAMPAIGN_MESSAGE_IDS; index += 1) {
        assert.deepEqual(queue.injectCampaignMessage(task.id, message(index)), {
          status: "accepted",
        });
      }
      assert.equal(received.length, MAX_CAMPAIGN_MESSAGE_IDS);
      assert.deepEqual(
        queue.injectCampaignMessage(task.id, message(MAX_CAMPAIGN_MESSAGE_IDS)),
        { status: "inbox_full", limit: MAX_CAMPAIGN_MESSAGE_IDS },
      );

      assert.notEqual(unsubscribe, undefined);
      assert.equal(queue.cancel(task.id), true);
      assert.deepEqual(queue.injectCampaignMessage(task.id, message(0)), {
        status: "subscriber_unavailable",
      });
      assert.deepEqual(
        queue.injectCampaignMessage(task.id, {
          ...message(MAX_CAMPAIGN_MESSAGE_IDS),
          id: "after-unsubscribe",
        }),
        { status: "subscriber_unavailable" },
      );

      releaseRunner();
      await queue.drain();
      assert.deepEqual(queue.injectCampaignMessage(task.id, message(0)), {
        status: "not_running",
        taskStatus: "completed",
      });
    } finally {
      allowSubscribe();
      releaseRunner();
      await queue.drain();
      store.close();
    }
  });

  await check("non-campaign tasks reject peer injection with a conflict result", async () => {
    const store = new SQLiteTaskStore(path.join(root, "non-campaign-inbox.db"));
    const queue = new TaskQueue({
      store,
      concurrency: 0,
      workspaceDirFor: (id) => path.join(root, id),
      runner: async () => outcome,
    });
    const task = queue.enqueue({
      createdBy: "check",
      prompt: "no radio",
      options: { tools: ["read"] },
    });
    const result = queue.injectCampaignMessage(task.id, {
      id: "message-1",
      thread: "research",
      from: "peer-a",
      content: "Should be refused.",
      priority: "normal",
      sentAt: "2026-08-22T16:00:00.000Z",
    });
    assert.deepEqual(result, { status: "feature_not_enabled" });
    queue.cancel(task.id);
    await queue.drain();
    store.close();
  });

  await check("artifact API view is bounded and excludes operational inputs", async () => {
    const workspace = path.join(root, "artifact-workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, "seed.txt"), "input", "utf8");
    await writeFile(path.join(workspace, "output.txt"), "output", "utf8");
    await writeFile(path.join(workspace, "result.json"), "{}", "utf8");
    await writeFile(path.join(root, "outside.txt"), "must-not-read", "utf8");
    for (let index = 0; index < 21; index += 1) {
      await writeFile(
        path.join(workspace, `page-${String(index).padStart(2, "0")}.txt`),
        String(index),
        "utf8",
      );
    }
    await writeFile(path.join(workspace, "oversized.bin"), Buffer.alloc(257 * 1024));
    const task = {
      id: "artifact-task",
      createdBy: "check",
      prompt: "artifact",
      status: "completed" as const,
      createdAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      workspaceDir: workspace,
      seedFiles: { "seed.txt": "input" },
      options: {},
      events: [],
    };
    const listing = await listTaskArtifacts(task);
    assert.equal(listing.files.length, 20);
    assert.notEqual(listing.nextCursor, undefined);
    const secondPage = await listTaskArtifacts(task, { cursor: listing.nextCursor });
    assert(
      [...listing.files, ...secondPage.files].some((file) => file.path === "output.txt"),
    );
    assert.equal(new TextDecoder().decode((await readTaskArtifact(task, "output.txt")).bytes), "output");
    await assert.rejects(readTaskArtifact(task, "../outside.txt"));
    await assert.rejects(
      readTaskArtifact(task, "oversized.bin"),
      (error: unknown) =>
        error instanceof Error &&
        "status" in error &&
        (error as { status?: unknown }).status === 413,
    );
  });

  // ------------------------------------------------------------ final state

  let linkKind = "";
  await check("final state: each seed reads unchanged, changed, absent or not_regular, and no link is followed", async () => {
    const base = path.join(root, "final-seeds");
    const workspace = path.join(base, "workspace");
    const outside = path.join(base, "outside");
    await mkdir(outside, { recursive: true });
    const secret = "outside-token-the-record-must-never-read";
    await writeFile(path.join(outside, "secret.js"), secret);
    const seedFiles = {
      "src/settle.js": "export const settle = 1;\n",
      "src/edited.js": "export const edited = 1;\n",
      "src/deleted.js": "export const deleted = 1;\n",
      "src/linked.js": "export const linked = 1;\n",
      "lib/inner.js": "export const inner = 1;\n",
      "campaign/context.json": '{"goal":"Complete the slice described in campaign/slice.md."}\n',
    };
    await writeTree(workspace, seedFiles);
    // What the task did: one seed edited, one deleted, one replaced by a link
    // out of the workspace, a seed's directory replaced by a link, and new
    // files beside the seeds, one of them a link too.
    await writeFile(path.join(workspace, "src", "edited.js"), "export const edited = 2;\n");
    await rm(path.join(workspace, "src", "deleted.js"));
    await rm(path.join(workspace, "src", "linked.js"));
    linkKind = await linkOut(path.join(outside, "secret.js"), path.join(workspace, "src", "linked.js"));
    await rm(path.join(workspace, "lib"), { recursive: true });
    await linkDirectory(outside, path.join(workspace, "lib"));
    await writeTree(workspace, {
      "src/helper.js": "export const helper = 1;\n",
      "test/fixtures/customers.csv": "id,name\n1,Ada\n",
    });
    await linkOut(path.join(outside, "secret.js"), path.join(workspace, "notes.js"));

    const record = await readTaskFinalState(endedTask("final-seeds", workspace, seedFiles));
    assert.equal(record.version, 1);
    assert.equal(record.taskId, "final-seeds");
    assert.equal(record.workspaceDir, workspace);
    assert.equal(record.workspaceDirReal, realpathSync.native(workspace));
    assert.equal(record.promptDigest, null);
    assert.deepEqual(
      record.seeds.map((seed) => seed.path),
      Object.keys(seedFiles),
      "one seed entry per key, in order",
    );
    const seed = (name: string) => record.seeds.find((entry) => entry.path === name)!;
    for (const [name, content] of Object.entries(seedFiles)) {
      assert.equal(seed(name).seededSha256, sha256(content), `${name}'s seeded hash`);
    }
    assert.deepEqual(
      Object.fromEntries(record.seeds.map((entry) => [entry.path, entry.state])),
      {
        "src/settle.js": "unchanged",
        "src/edited.js": "changed",
        "src/deleted.js": "absent",
        "src/linked.js": "not_regular",
        "lib/inner.js": "not_regular",
        "campaign/context.json": "unchanged",
      },
    );
    assert.equal(seed("src/settle.js").content, seedFiles["src/settle.js"]);
    assert.equal(seed("src/edited.js").sha256, sha256("export const edited = 2;\n"));
    assert.equal(seed("src/edited.js").content, "export const edited = 2;\n");
    for (const name of ["src/deleted.js", "src/linked.js", "lib/inner.js"]) {
      assert.equal(seed(name).sha256, null, `${name} has no hash`);
      assert.equal(seed(name).content, null, `${name} has no content`);
    }
    assert.equal(seed("src/deleted.js").size, 0, "an absent seed's size is 0");
    assert.equal(seed("lib/inner.js").size, 0, "nothing behind a linked directory is examined");
    assert.deepEqual(
      record.files.map((file) => [file.path, file.type, file.contentOmitted]),
      [
        ["lib", "symlink", "symlink"],
        ["notes.js", "symlink", "symlink"],
        ["src/helper.js", "file", "none"],
        ["test/fixtures/customers.csv", "file", "none"],
      ],
      "every other file and link, and no seed path",
    );
    for (const file of record.files.filter((entry) => entry.type === "symlink")) {
      assert.equal(file.sha256, null, `${file.path} is a link and has no hash`);
    }
    assert.equal(record.files.find((file) => file.path === "src/helper.js")!.sha256, sha256("export const helper = 1;\n"));
    assert.ok(!JSON.stringify(record).includes(secret), "a link's target was read");
    assert.deepEqual(record.result, { present: false, sha256: null, size: 0, content: null });
  });
  console.log(`      the links here are ${linkKind}`);

  await check("final state: a workspace replaced by a link is recorded as that link, and its target is never read", async () => {
    const base = path.join(root, "final-linked-workspace");
    const elsewhere = path.join(base, "elsewhere");
    const workspace = path.join(base, "workspace");
    const seedFiles = { "src/settle.js": "export const settle = 1;\n" };
    const foreign = "content-of-a-directory-that-is-not-the-workspace";
    await writeTree(elsewhere, { ...seedFiles, "notes.txt": foreign, "result.json": `{"summary":"${foreign}"}` });
    await linkDirectory(elsewhere, workspace);
    const record = await readTaskFinalState(endedTask("final-linked-workspace", workspace, seedFiles));
    assert.equal(record.workspaceDirReal, path.join(realpathSync.native(base), "workspace"), "the link's own path, not its target's");
    assert.deepEqual(
      record.seeds.map((seed) => [seed.path, seed.state, seed.sha256, seed.size]),
      [["src/settle.js", "not_regular", null, 0]],
    );
    assert.deepEqual(
      record.files.map((file) => [file.path, file.type, file.sha256, file.contentOmitted]),
      [[".", "symlink", null, "symlink"]],
    );
    assert.deepEqual(record.result, { present: true, sha256: null, size: 0, content: null });
    assert.ok(!JSON.stringify(record).includes(foreign), "the link's target was read");
  });

  // Read access is taken away and given back around the check, so the
  // temporary directory can still be removed whatever the check does.
  {
    const label =
      "final state: a file, a seed, a directory or result.json that cannot be read is unreadable, and the rest of the record stands";
    const workspace = path.join(root, "final-unreadable");
    const sealedRoot = path.join(root, "final-unreadable-root");
    const seedFiles = {
      "src/settle.js": "export const settle = 1;\n",
      "src/locked.js": "export const locked = 1;\n",
    };
    const tree = {
      ...seedFiles,
      "locked.txt": "a file the task made unreadable\n",
      "readable.txt": "a file beside it\n",
      "sealed/inner.txt": "below a directory that cannot be listed\n",
      "result.json": '{"status":"success","summary":"done"}\n',
    };
    await writeTree(workspace, tree);
    await writeTree(sealedRoot, { "src/settle.js": seedFiles["src/settle.js"] });
    const undos: (() => Promise<void>)[] = [];
    let skipped: string | undefined;
    for (const [target, kind] of [
      [path.join(workspace, "src", "locked.js"), "file"],
      [path.join(workspace, "locked.txt"), "file"],
      [path.join(workspace, "sealed"), "directory"],
      [path.join(workspace, "result.json"), "file"],
      [sealedRoot, "directory"],
    ] as const) {
      const denied = await denyRead(target, kind);
      if ("reason" in denied) {
        skipped = denied.reason;
        break;
      }
      undos.push(denied.undo);
    }
    try {
      if (skipped !== undefined) {
        console.log(`SKIP  ${label} -- ${skipped}`);
      } else {
        await check(label, async () => {
          const record = await readTaskFinalState(endedTask("final-unreadable", workspace, seedFiles));
          assert.deepEqual(
            record.seeds.map((seed) => [seed.path, seed.state, seed.sha256, seed.content, seed.contentOmitted]),
            [
              ["src/settle.js", "unchanged", sha256(seedFiles["src/settle.js"]), seedFiles["src/settle.js"], "none"],
              ["src/locked.js", "unreadable", null, null, "none"],
            ],
          );
          assert.equal(record.seeds[1]!.size, Buffer.byteLength(seedFiles["src/locked.js"]), "an unreadable seed's size is lstat's");
          assert.deepEqual(
            record.files.map((file) => [file.path, file.type, file.sha256, file.content, file.contentOmitted]),
            [
              ["locked.txt", "file", null, null, "unreadable"],
              ["readable.txt", "file", sha256(tree["readable.txt"]), tree["readable.txt"], "none"],
              ["sealed", "directory", null, null, "unreadable"],
            ],
            "the unreadable entries in their places, and nothing below the directory",
          );
          assert.equal(record.files[0]!.size, Buffer.byteLength(tree["locked.txt"]), "an unreadable file's size is lstat's");
          assert.deepEqual(record.result, {
            present: true,
            sha256: null,
            size: Buffer.byteLength(tree["result.json"]),
            content: null,
          });

          // A workspace that cannot be listed at all is `.`, and still a record.
          const sealed = await readTaskFinalState(endedTask("final-unreadable-root", sealedRoot, { "src/settle.js": seedFiles["src/settle.js"] }));
          assert.deepEqual(
            sealed.files.map((file) => [file.path, file.type, file.sha256, file.contentOmitted]),
            [[".", "directory", null, "unreadable"]],
          );
          assert.equal(sealed.seeds.length, 1);
        });
      }
    } finally {
      for (const undo of undos.reverse()) await undo();
    }
  }

  await check("final state: 600 small files and a top-level CHANGES.md are all listed; the deepest lose their content first", async () => {
    const workspace = path.join(root, "final-many");
    const body = (index: number) => `${String(index).padStart(4, "0")} `.repeat(400);
    const tree: Record<string, string> = {
      "CHANGES.md": "## Changes\n- settle() rounds half up\n",
      "test/fixtures/customers.csv": "id,name\n1,Ada\n",
    };
    // A tree of the kind a task builds, deeper than anything measured and
    // sorting first: it must cost the measured files nothing.
    for (let index = 0; index < 600; index += 1) {
      tree[`a/node_modules/pkg/file-${String(index).padStart(3, "0")}.js`] = body(index);
    }
    await writeTree(workspace, tree);
    const record = await readTaskFinalState(endedTask("final-many", workspace));
    assert.equal(record.files.length, 602);
    assert.equal(record.filesOmitted, 0);
    assert.deepEqual(
      record.files.map((file) => file.path),
      Object.keys(tree).sort(depthThenPath),
      "listed by depth, then by path",
    );
    for (const file of record.files) {
      assert.equal(file.sha256, sha256(tree[file.path]!), `${file.path}'s hash`);
      assert.equal(file.size, Buffer.byteLength(tree[file.path]!), `${file.path}'s size`);
    }
    const file = (name: string) => record.files.find((entry) => entry.path === name)!;
    assert.equal(file("CHANGES.md").content, tree["CHANGES.md"]);
    assert.equal(file("test/fixtures/customers.csv").content, tree["test/fixtures/customers.csv"]);
    const deep = record.files.filter((entry) => entry.path.startsWith("a/"));
    const firstOmitted = deep.findIndex((entry) => entry.contentOmitted === "budget");
    assert.ok(firstOmitted > 0, "some deep files keep their content and some lose it");
    assert.ok(
      deep.slice(firstOmitted).every((entry) => entry.contentOmitted === "budget" && entry.content === null),
      "content runs out in listing order",
    );
    const kept = record.files.reduce((sum, entry) => sum + (entry.content === null ? 0 : entry.size), 0);
    assert.ok(kept <= FINAL_STATE_CONTENT_BUDGET_BYTES, `${kept} bytes of content kept`);
    console.log(`      ${firstOmitted} of 600 deep files kept their content; ${kept} bytes in all`);
  });

  await check("final state: content bounds, result.json's raw bytes, and the entry limit", async () => {
    const workspace = path.join(root, "final-bounds");
    const invalidJson = '{"status":"success","summary":"cut off here';
    await writeTree(workspace, {
      "at-limit.txt": "x".repeat(FINAL_STATE_MAX_CONTENT_BYTES),
      "over-limit.txt": "x".repeat(FINAL_STATE_MAX_CONTENT_BYTES + 1),
      "binary.bin": Uint8Array.from([0xff, 0xfe, 0x00, 0xc3]),
      "bom.txt": "\uFEFFwith a byte order mark\n",
      "result.json": invalidJson,
    });
    const record = await readTaskFinalState(endedTask("final-bounds", workspace));
    const file = (name: string) => record.files.find((entry) => entry.path === name)!;
    assert.equal(file("at-limit.txt").contentOmitted, "none");
    assert.equal(file("at-limit.txt").content?.length, FINAL_STATE_MAX_CONTENT_BYTES);
    assert.equal(file("over-limit.txt").contentOmitted, "too_large");
    assert.equal(file("over-limit.txt").content, null);
    assert.equal(file("over-limit.txt").sha256, sha256("x".repeat(FINAL_STATE_MAX_CONTENT_BYTES + 1)));
    assert.equal(file("binary.bin").contentOmitted, "binary");
    assert.equal(file("binary.bin").content, null);
    assert.equal(file("bom.txt").content, "\uFEFFwith a byte order mark\n", "the byte order mark is kept");
    assert.ok(!record.files.some((entry) => entry.path === "result.json"), "result.json is never a file entry");
    assert.deepEqual(record.result, {
      present: true,
      sha256: sha256(invalidJson),
      size: invalidJson.length,
      content: invalidJson,
    });

    const large = path.join(root, "final-large-result");
    const oversized = JSON.stringify({ pad: "y".repeat(256 * 1024) });
    await writeTree(large, { "result.json": oversized });
    const largeRecord = await readTaskFinalState(endedTask("final-large-result", large));
    assert.deepEqual(largeRecord.result, {
      present: true,
      sha256: sha256(oversized),
      size: oversized.length,
      content: null,
    });

    const limited = await readTaskFinalState(endedTask("final-bounds", workspace), { maxFiles: 2 });
    assert.deepEqual(
      limited.files.map((entry) => entry.path),
      ["at-limit.txt", "binary.bin"],
      "the first entries in listing order are kept",
    );
    assert.equal(limited.filesOmitted, 2);
  });

  await check("final-state route: 409 task_active while the task runs, 404 to another caller, the record once it ends", async () => {
    const store = new SQLiteTaskStore(path.join(root, "final-state-route.db"));
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const raw = '{"status":"success","summary":"done"}\n';
    const queue = new TaskQueue({
      store,
      concurrency: 1,
      workspaceDirFor: (id) => path.join(root, "final-state-route", id),
      // Seeds the workspace as the runner does, then holds the task running.
      runner: async (task) => {
        await writeTree(task.workspaceDir, task.seedFiles ?? {});
        await released;
        await writeFile(path.join(task.workspaceDir, "result.json"), raw);
        return outcome;
      },
    });
    const owner = "owner-token-0123456789abcdef";
    const intruder = "intruder-token-0123456789abcdef";
    const server = createServer(
      createRequestListener({
        config: {
          ...config,
          credentials: [
            { id: "owner", token: owner },
            { id: "intruder", token: intruder },
          ],
        } as Config,
        queue,
        models: { isKnown: () => true, ids: () => [], contextWindow: () => undefined },
        monitor: { listItems: () => [], listRuns: () => [] },
        rateLimiter: new TokenBucketRateLimiter(10_000, 10_000),
        namedSkills: new Map(),
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const as = (token: string) => ({ authorization: `Bearer ${token}` });
    try {
      const created = await fetch(`${base}/tasks`, {
        method: "POST",
        headers: { ...as(owner), "content-type": "application/json" },
        body: JSON.stringify({ task: "final state", files: { "src/settle.js": "export const settle = 1;\n" } }),
      });
      assert.equal(created.status, 202);
      const { id } = (await created.json()) as { id: string };
      while (queue.get(id)?.status !== "running") await new Promise((resolve) => setTimeout(resolve, 5));

      const active = await fetch(`${base}/tasks/${id}/final-state`, { headers: as(owner) });
      assert.equal(active.status, 409);
      assert.equal(((await active.json()) as { code?: string }).code, "task_active");
      const foreign = await fetch(`${base}/tasks/${id}/final-state`, { headers: as(intruder) });
      assert.equal(foreign.status, 404);

      release();
      await queue.drain();
      const ended = await fetch(`${base}/tasks/${id}/final-state`, { headers: as(owner) });
      assert.equal(ended.status, 200);
      const record = (await ended.json()) as TaskFinalState;
      assert.equal(record.taskId, id);
      assert.deepEqual(
        record.seeds.map((entry) => [entry.path, entry.state]),
        [["src/settle.js", "unchanged"]],
      );
      assert.equal(record.result.content, raw);
      assert.equal(record.result.sha256, sha256(raw));
      const missing = await fetch(`${base}/tasks/no-such-task/final-state`, { headers: as(owner) });
      assert.equal(missing.status, 404);
      const health = (await (await fetch(`${base}/healthz`)).json()) as Record<string, unknown>;
      assert.ok("model" in health, "/healthz always carries model");
      assert.equal(health["model"], null, "and it is null when no resolved model was given");
    } finally {
      release();
      await queue.drain();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      store.close();
    }
  });

  await check("SQLite task store persists caller-scoped concurrent deduplication", async () => {
    const store = new SQLiteTaskStore(dbPath);
    let firstId = "";
    let otherId = "";
    try {
      const created = await Promise.all(
        ["first", "duplicate"].map(async (prompt) =>
          store.create(
            { createdBy: "check", requestKey: "dedup-1", prompt },
            path.join(root, prompt),
          ),
        ),
      );
      const first = created[0]!;
      const repeated = created[1]!;
      const otherCaller = store.create(
        { createdBy: "other", requestKey: "dedup-1", prompt: "other" },
        path.join(root, "other"),
      );
      firstId = first.id;
      otherId = otherCaller.id;
      assert.equal(repeated.id, first.id);
      assert.notEqual(otherCaller.id, first.id);
    } finally {
      store.close();
    }
    const reopened = new SQLiteTaskStore(dbPath);
    try {
      assert.equal(reopened.getByRequestKey("check", "dedup-1")?.id, firstId);
      assert.equal(reopened.getByRequestKey("other", "dedup-1")?.id, otherId);
    } finally {
      reopened.close();
    }
  });

  await check("a maintenance connection does not interrupt live work", async () => {
    // `prune-workspaces` opens this store, and recovery used to run unconditionally in
    // the constructor. Against a live worker that marked its running tasks `interrupted`
    // while their runners carried on: the API then refuses to cancel them as already
    // terminal, and the overlord starts replacements for work that is still going.
    const maintenanceDb = path.join(root, "maintenance.db");
    const live = new SQLiteTaskStore(maintenanceDb);
    const task = live.create(
      { createdBy: "check", requestKey: "live-1", prompt: "running" },
      path.join(root, "live-1"),
    );
    live.update(task.id, { status: "running", startedAt: new Date().toISOString() });

    const maintenance = new SQLiteTaskStore(maintenanceDb, { recover: false });
    try {
      assert.equal(maintenance.get(task.id)?.status, "running");
      // And the live connection still sees its own task as running.
      assert.equal(live.get(task.id)?.status, "running");
    } finally {
      maintenance.close();
    }
    // Taking ownership still recovers, which is what a real restart needs.
    const owner = new SQLiteTaskStore(maintenanceDb);
    try {
      assert.equal(owner.get(task.id)?.status, "interrupted");
    } finally {
      owner.close();
      live.close();
    }
  });

  await check("restart marks running tasks interrupted and restores queued work", async () => {
    const before = new SQLiteTaskStore(dbPath);
    const running = before.create(
      { createdBy: "check", requestKey: "running-1", prompt: "running" },
      path.join(root, "running"),
    );
    before.update(running.id, { status: "running", startedAt: new Date().toISOString() });
    const queued = before.create(
      { createdBy: "check", requestKey: "queued-1", prompt: "queued" },
      path.join(root, "queued"),
    );
    before.close();

    const after = new SQLiteTaskStore(dbPath);
    assert.equal(after.get(running.id)?.status, "interrupted");
    assert.equal(after.get(running.id)?.stoppedBy, "interrupted");
    const queue = new TaskQueue({
      store: after,
      concurrency: 1,
      workspaceDirFor: (id) => path.join(root, id),
      runner: async () => outcome,
    });
    while (after.get(queued.id)?.status === "queued") {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await queue.drain();
    assert.equal(after.get(queued.id)?.status, "completed");
    after.close();
  });

  await check("startup restore enforces age and count caps", async () => {
    const store = new SQLiteTaskStore(path.join(root, "restore-cap.db"));
    const recent = store.create(
      { createdBy: "check", prompt: "recent" },
      path.join(root, "recent"),
    );
    const excess = store.create(
      { createdBy: "check", prompt: "excess" },
      path.join(root, "excess"),
    );
    const old = store.create(
      { createdBy: "check", prompt: "old" },
      path.join(root, "old"),
    );
    store.update(old.id, { createdAt: "2020-01-01T00:00:00.000Z" });
    const queue = new TaskQueue({
      store,
      concurrency: 1,
      restoreMaxTasks: 1,
      restoreMaxAgeMs: 60_000,
      workspaceDirFor: (id) => path.join(root, id),
      runner: async () => outcome,
    });
    try {
      while (
        [recent.id, excess.id].some((id) => store.get(id)?.status === "queued")
      ) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const statuses = [recent.id, excess.id, old.id].map(
        (id) => store.get(id)?.status,
      );
      assert.equal(statuses.filter((status) => status === "completed").length, 1);
      assert.equal(statuses.filter((status) => status === "interrupted").length, 2);
    } finally {
      await queue.drain();
      store.close();
    }
  });

  await check("queue drain waits for in-flight work", async () => {
    const store = new SQLiteTaskStore(path.join(root, "drain.db"));
    const queue = new TaskQueue({
      store,
      concurrency: 1,
      workspaceDirFor: (id) => path.join(root, id),
      runner: async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return outcome;
      },
    });
    const task = queue.enqueue({ createdBy: "check", prompt: "drain me" });
    while (store.get(task.id)?.status === "queued") {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await queue.drain();
    assert.equal(store.get(task.id)?.status, "completed");
    assert.throws(
      () => queue.enqueue({ createdBy: "check", prompt: "too late" }),
      TaskQueueShuttingDownError,
    );
    store.close();
  });

  await check("forced shutdown bounds a runner that ignores abort", async () => {
    const store = new SQLiteTaskStore(path.join(root, "ignored-abort.db"));
    const queue = new TaskQueue({
      store,
      concurrency: 1,
      workspaceDirFor: (id) => path.join(root, id),
      runner: async () => {
        await new Promise((resolve) => setTimeout(resolve, 75));
        return outcome;
      },
    });
    const task = queue.enqueue({ createdBy: "check", prompt: "ignore abort" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const drain = queue.drain();
    queue.cancelAll();
    queue.interruptRemaining("forced test shutdown");
    await drain;
    assert.equal(store.get(task.id)?.status, "interrupted");
    await new Promise((resolve) => setTimeout(resolve, 100));
    store.close();
  });

  await check("retention prunes expired and orphaned workspaces but never outside root", async () => {
    const workspaces = path.join(root, "retention-workspaces");
    const outside = path.join(root, "outside-retention");
    await mkdir(workspaces, { recursive: true });
    await mkdir(outside, { recursive: true });
    const old = new Date("2020-01-01T00:00:00.000Z");
    await utimes(outside, old, old);
    const store = new SQLiteTaskStore(path.join(root, "retention.db"));
    const externalTask = store.create(
      { createdBy: "check", prompt: "outside" },
      outside,
    );
    store.update(externalTask.id, {
      status: "completed",
      finishedAt: old.toISOString(),
    });
    const orphan = path.join(workspaces, "orphan");
    await mkdir(orphan);
    await utimes(orphan, old, old);
    const count = await pruneExpiredTasks(store, workspaces, 30, Date.now());
    assert.equal(count, 2);
    await access(outside);
    await assert.rejects(access(orphan));
    store.close();
  });

  await check("retention prunes a task's event log with it, and old orphaned logs", async () => {
    const workspaces = path.join(root, "retention-log-workspaces");
    const logs = path.join(root, "retention-logs");
    await mkdir(workspaces, { recursive: true });
    await mkdir(logs, { recursive: true });
    const old = new Date("2020-01-01T00:00:00.000Z");
    const store = new SQLiteTaskStore(path.join(root, "retention-logs.db"));
    const expired = store.create({ createdBy: "check", prompt: "expired" }, "");
    store.update(expired.id, {
      workspaceDir: path.join(workspaces, expired.id),
      status: "completed",
      finishedAt: old.toISOString(),
    });
    const kept = store.create({ createdBy: "check", prompt: "kept" }, "");
    store.update(kept.id, {
      workspaceDir: path.join(workspaces, kept.id),
      status: "completed",
      finishedAt: new Date().toISOString(),
    });
    for (const id of [expired.id, kept.id, "orphan-old", "orphan-fresh"]) {
      await writeFile(eventLogFile(logs, id), '{"seq":1}\n');
    }
    await utimes(eventLogFile(logs, "orphan-old"), old, old);
    await utimes(eventLogFile(logs, kept.id), old, old);
    await pruneExpiredTasks(store, workspaces, 30, Date.now(), logs);
    await assert.rejects(access(eventLogFile(logs, expired.id)), "the expired task's log");
    await assert.rejects(access(eventLogFile(logs, "orphan-old")), "an old log with no task");
    // An old mtime does not expire a log whose task is still retained.
    await access(eventLogFile(logs, kept.id));
    await access(eventLogFile(logs, "orphan-fresh"));
    store.close();
  });
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nall queue checks passed" : `\n${failures} queue check(s) failed`);
process.exit(failures === 0 ? 0 : 1);

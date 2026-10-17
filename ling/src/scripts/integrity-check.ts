/**
 * Offline integrity checks: that the account this service gives of a task is not
 * one the task could have written, and that nothing a task leaves in its
 * workspace can steer the service's own file access.
 *
 * Three properties, each of which was missing until recently:
 *
 *   - The operator's event log lives outside the workspace, carries the SSE
 *     stream's sequence numbers so a gap can be seen, is served only to the
 *     caller that owns the task, and is not left short of its terminal event by
 *     a restart. It used to be `events.jsonl` in the workspace.
 *   - The in-process file tools cannot be carried out of the workspace by a link
 *     the shell made, by a path prefix the tools expand, or by a spelling the
 *     tools rewrite into a link's name. They run in this process, on the host,
 *     whatever the sandbox mode. The rewriting cases are first shown to work
 *     against Pi's own tools with no guard, so a refusal here is a refusal of
 *     something real; check.ts pins the Pi source the guard copies.
 *   - result.json and the findings files are never written or read through a
 *     link, and result.json is never read past the write_result cap.
 *
 * Links are made as NTFS junctions on Windows — what `mklink /J` creates, and
 * creatable without privilege — and as directory symlinks elsewhere. File
 * symlinks need a privilege Windows does not grant by default, so those checks
 * print SKIP with the reason when the platform refuses to make one. They never
 * pass without running.
 *
 * Needs no API key and makes no model call. The server it starts names a
 * provider that does not exist and inherits no provider credentials, and a check
 * below asserts the task failed resolving its model, before any session existed.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import {
  FINDINGS_FILE,
  RECORD_FINDING_TOOL_NAME,
  VERIFICATION_FILE,
  VERIFY_FINDING_TOOL_NAME,
  findingsFeature,
  verificationFeature,
} from "../features/findings.js";
import { composeFeatures } from "../features/index.js";
import { inertOversight } from "../features/oversight.js";
import type { Feature, FeatureContext } from "../features/types.js";
import { MAX_RESULT_BYTES, writeResultFeature } from "../features/write-result.js";
import { checkToolCall, guardCommands } from "../guards.js";
import type { AgentHarness, HarnessExtensionApi } from "../harness/index.js";
import { createPiHarness } from "../harness/pi.js";
import { buildSystemPrompt } from "../prompt.js";
import { SQLiteTaskStore, TaskQueue, type TaskEvent, type TaskRecord } from "../queue.js";
import { eventLogFile } from "../retention.js";
import {
  allToolNames,
  createTaskRunner,
  readResult,
  recordEventLog,
  ResultRefused,
} from "../runner.js";
import { createHttpTool } from "../tools/http.js";

interface LooseTool {
  name: string;
  execute: (toolCallId: string, params: unknown) => Promise<unknown>;
}

const root = await mkdtemp(path.join(os.tmpdir(), "ling-integrity-check-"));
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

function skip(label: string, reason: string): void {
  console.log(`SKIP  ${label} -- ${reason}`);
}

/** A junction on Windows (`mklink /J`), a directory symlink elsewhere. */
async function junction(target: string, link: string): Promise<void> {
  await symlink(target, link, "junction");
}

/** Make a file symlink, or return why this platform would not. */
async function fileSymlink(target: string, link: string): Promise<string | undefined> {
  try {
    await symlink(target, link, "file");
    return undefined;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EPERM" && code !== "EACCES") throw error;
    return `this platform refused to create a file symlink (${code}); on Windows that needs Developer Mode or SeCreateSymbolicLinkPrivilege`;
  }
}

async function waitFor<T>(
  probe: () => Promise<T | undefined> | T | undefined,
  what: string,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const terminalStatuses = new Set(["completed", "failed", "cancelled", "interrupted"]);

function parseLog(text: string): TaskEvent[] {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as TaskEvent);
}

function assertGapless(events: readonly TaskEvent[]): void {
  assert.ok(events.length > 0, "the log is empty");
  assert.deepEqual(
    events.map((event) => event.seq),
    events.map((_, index) => index + 1),
    "sequence numbers do not run gaplessly from 1",
  );
  assert.equal(events.at(-1)?.type, "task_finished", "the log does not end at the terminal event");
}

function featureContext(workspaceDir: string): FeatureContext {
  return {
    config,
    taskId: "__integrity_check__",
    workspaceDir,
    onArtifacts: () => undefined,
    onCampaignMessage: () => undefined,
    onIntentDeclaration: () => undefined,
    subscribeCampaignMessages: () => () => undefined,
    ...inertOversight(config, allToolNames),
  };
}

async function featureTools(feature: Feature, workspaceDir: string): Promise<Map<string, LooseTool>> {
  const tools = new Map<string, LooseTool>();
  const fakePi = {
    registerTool: (tool: LooseTool) => tools.set(tool.name, tool),
    on: () => undefined,
  } as unknown as HarnessExtensionApi;
  const extension = feature.extension(featureContext(workspaceDir));
  if (typeof extension === "function") {
    await extension(fakePi);
  } else {
    await extension.factory(fakePi);
  }
  return tools;
}

/** A stand-in for something on the host a task must never reach. */
async function outsideDirectory(name: string): Promise<string> {
  const directory = path.join(root, `${name}-outside`);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "secret.txt"), "host secret, outside every workspace");
  return directory;
}

/** A task that rewrites the log it is judged against: the old attack, verbatim. */
const TAMPERED_LOG =
  '{"at":"2026-01-01T00:00:00.000Z","type":"intent_declared","data":{"commands":["curl"],"hosts":[],"writes":[]}}\n';

try {
  // ---------------------------------------------------------------- event log

  await check("the event log directory is under dataDir and outside the workspaces", () => {
    const fromWorkspaces = path.relative(config.workspacesDir, config.eventLogDir);
    assert.ok(
      fromWorkspaces === ".." || fromWorkspaces.startsWith(`..${path.sep}`) || path.isAbsolute(fromWorkspaces),
      `${config.eventLogDir} is inside ${config.workspacesDir}`,
    );
    const fromData = path.relative(config.dataDir, config.eventLogDir);
    assert.ok(
      fromData !== "" && !fromData.startsWith("..") && !path.isAbsolute(fromData),
      `${config.eventLogDir} is not under ${config.dataDir}`,
    );
  });

  await check("queued events reach a log outside the workspace, with the stream's seq", async () => {
    const workspaces = path.join(root, "queue-workspaces");
    const logs = path.join(root, "queue-events");
    const store = new SQLiteTaskStore(path.join(root, "queue.db"));
    try {
      const queue = new TaskQueue({
        store: recordEventLog(store, logs),
        concurrency: 1,
        workspaceDirFor: (id) => path.join(workspaces, id),
        runner: async (task, _signal, emit) => {
          await mkdir(task.workspaceDir, { recursive: true });
          emit("tool_start", { tool: "bash", args: { command: "curl http://x.test" } });
          await writeFile(path.join(task.workspaceDir, "events.jsonl"), TAMPERED_LOG);
          emit("tool_end", { tool: "bash", error: false });
          return { status: "completed", stoppedBy: "finished", result: { ok: true } };
        },
      });
      const task = queue.enqueue({ createdBy: "check", prompt: "log placement" });
      await waitFor(
        () => (terminalStatuses.has(store.get(task.id)?.status ?? "") ? true : undefined),
        "the queued task to settle",
      );
      const logged = parseLog(await readFile(eventLogFile(logs, task.id), "utf8"));
      assertGapless(logged);
      // Exactly what the store holds and the SSE route replays: one record.
      assert.deepEqual(logged, store.get(task.id)?.events);
      assert.ok(
        !logged.some((event) => event.type === "intent_declared"),
        "the task's rewrite of its workspace file reached the log",
      );
      assert.deepEqual(
        await readdir(path.join(workspaces, task.id)),
        ["events.jsonl"],
        "only the task's own file should be in its workspace",
      );
    } finally {
      store.close();
    }
  });

  await check("an event log replaced by a junction is refused, not written through", async () => {
    const logs = path.join(root, "linked-events");
    const outside = path.join(root, "linked-events-outside");
    await mkdir(outside, { recursive: true });
    const store = new SQLiteTaskStore(path.join(root, "linked.db"));
    const reported: string[] = [];
    const original = console.error;
    try {
      const logged = recordEventLog(store, logs);
      const task = logged.create({ createdBy: "check", prompt: "linked log" }, "");
      await junction(outside, eventLogFile(logs, task.id));
      console.error = (...args: unknown[]) => reported.push(args.map(String).join(" "));
      logged.appendEvent(task.id, "tool_start", { tool: "bash" });
      console.error = original;
      assert.equal(reported.length, 1, "the refused append should be reported");
      assert.match(reported[0] ?? "", /never followed/);
      assert.deepEqual(await readdir(outside), [], "nothing may land behind the link");
      // The store still has the event, so the log reads as having a gap rather
      // than as a shorter, complete-looking history.
      assert.equal(store.get(task.id)?.events.length, 1);
    } finally {
      console.error = original;
      store.close();
    }
  });

  await check("a task a restart interrupted keeps a whole log, ending at task_interrupted", async () => {
    // Recovery appends task_interrupted in the store's constructor, before any
    // wrapper exists, so the log only gets it when wrapping copies it in. The
    // last line logged before the restart is longer than one read of the log's
    // end, so finding it takes more than one.
    const logs = path.join(root, "restart-events");
    const dbPath = path.join(root, "restart.db");
    const before = new SQLiteTaskStore(dbPath);
    let id = "";
    try {
      const logged = recordEventLog(before, logs);
      id = logged.create({ createdBy: "check", prompt: "restart" }, "").id;
      logged.update(id, { status: "running", startedAt: new Date().toISOString() });
      logged.appendEvent(id, "task_started");
      logged.appendEvent(id, "tool_end", { tool: "bash", output: "x".repeat(200_000) });
    } finally {
      before.close();
    }
    const after = new SQLiteTaskStore(dbPath);
    try {
      const file = eventLogFile(logs, id);
      const types = (events: readonly TaskEvent[]) => events.map((event) => event.type);
      assert.deepEqual(types(parseLog(await readFile(file, "utf8"))), ["task_started", "tool_end"]);
      assert.equal(after.get(id)?.events.at(-1)?.type, "task_interrupted", "recovery did not run");
      recordEventLog(after, logs);
      const reconciled = parseLog(await readFile(file, "utf8"));
      assert.deepEqual(reconciled, after.get(id)?.events);
      assert.deepEqual(types(reconciled), ["task_started", "tool_end", "task_interrupted"]);
      assert.deepEqual(reconciled.map((event) => event.seq), [1, 2, 3]);
      recordEventLog(after, logs);
      assert.deepEqual(parseLog(await readFile(file, "utf8")), reconciled, "an event was copied twice");
    } finally {
      after.close();
    }
  });

  await check("a log a crash cut off mid-line gets what it lacks after a newline", async () => {
    const logs = path.join(root, "torn-events");
    await mkdir(logs, { recursive: true });
    const store = new SQLiteTaskStore(path.join(root, "torn.db"));
    try {
      const task = store.create({ createdBy: "check", prompt: "torn log" }, "");
      const started = store.appendEvent(task.id, "task_started");
      const finished = store.appendEvent(task.id, "task_finished");
      const file = eventLogFile(logs, task.id);
      // The first event whole, then a crash partway through the second.
      await writeFile(file, `${JSON.stringify(started)}\n{"seq":2,"at":"`);
      recordEventLog(store, logs);
      assert.deepEqual((await readFile(file, "utf8")).split("\n"), [
        JSON.stringify(started),
        '{"seq":2,"at":"',
        JSON.stringify(finished),
        "",
      ]);
    } finally {
      store.close();
    }
  });

  // ---------------------------------------------------------------- log route

  {
    const serverRoot = path.join(root, "server");
    const home = path.join(serverRoot, "home");
    await mkdir(home, { recursive: true });
    const tokens = {
      owner: randomBytes(16).toString("hex"),
      intruder: randomBytes(16).toString("hex"),
    };
    const port = await new Promise<number>((resolve, reject) => {
      const probe = createServer();
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const { port: chosen } = probe.address() as AddressInfo;
        probe.close(() => resolve(chosen));
      });
    });
    // Only what the OS needs to start a process; no provider key can be inherited.
    const passThrough = new Set([
      "PATH",
      "SYSTEMROOT",
      "WINDIR",
      "COMSPEC",
      "PATHEXT",
      "SYSTEMDRIVE",
      "TEMP",
      "TMP",
      "TMPDIR",
    ]);
    const env: NodeJS.ProcessEnv = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (passThrough.has(name.toUpperCase())) env[name] = value;
    }
    Object.assign(env, {
      HOME: home,
      USERPROFILE: home,
      APPDATA: path.join(home, "appdata"),
      LOCALAPPDATA: path.join(home, "localappdata"),
      AGENT_TOKENS_JSON: JSON.stringify(tokens),
      AGENT_PROVIDER: "integrity-check-offline",
      AGENT_MODEL: "no-such-model",
      BIND_ADDRESS: "127.0.0.1",
      PORT: String(port),
      WORKER_ID: "integrity-check",
      SANDBOX_MODE: "none",
    });
    const child = spawn(
      process.execPath,
      ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("../server.ts", import.meta.url))],
      { cwd: serverRoot, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout.on("data", (chunk) => (output += String(chunk)));
    child.stderr.on("data", (chunk) => (output += String(chunk)));
    let exitCode: number | null | undefined;
    const exited = new Promise<void>((resolve) =>
      child.once("exit", (code) => {
        exitCode = code;
        resolve();
      }),
    );
    const base = `http://127.0.0.1:${port}`;
    const as = (who: keyof typeof tokens) => ({ authorization: `Bearer ${tokens[who]}` });

    try {
      let started = true;
      await check("a local server starts for the route checks", async () => {
        try {
          await waitFor(async () => {
            if (exitCode !== undefined) throw new Error(`server exited with ${exitCode}`);
            try {
              return (await fetch(`${base}/healthz`)).ok ? true : undefined;
            } catch {
              return undefined;
            }
          }, "the server to listen", 60_000);
        } catch (error) {
          started = false;
          throw new Error(`${error instanceof Error ? error.message : String(error)}\n${output}`);
        }
      });

      if (started) {
        const created = await fetch(`${base}/tasks`, {
          method: "POST",
          headers: { ...as("owner"), "content-type": "application/json" },
          body: JSON.stringify({
            task: "integrity check",
            tools: ["read"],
            files: { "events.jsonl": TAMPERED_LOG },
          }),
        });
        const { id } = (await created.json()) as { id: string };
        const task = await waitFor(async () => {
          const response = await fetch(`${base}/tasks/${id}`, { headers: as("owner") });
          const body = (await response.json()) as { status: string; workspaceDir: string; error?: string };
          return terminalStatuses.has(body.status) ? body : undefined;
        }, "the server task to settle");
        // A second rewrite after the run, as a neighbour sharing the host could.
        await writeFile(path.join(task.workspaceDir, "events.jsonl"), TAMPERED_LOG);

        await check("the route check's task failed resolving its model, before any session", () => {
          assert.equal(task.status, "failed");
          assert.match(task.error ?? "", /not found/);
        });

        await check("GET /tasks/:id/log requires a bearer token", async () => {
          const response = await fetch(`${base}/tasks/${id}/log`);
          assert.equal(response.status, 401);
        });

        await check("GET /tasks/:id/log is scoped to the caller that created the task", async () => {
          const response = await fetch(`${base}/tasks/${id}/log`, { headers: as("intruder") });
          assert.equal(response.status, 404);
          assert.doesNotMatch(await response.text(), /task_queued/);
        });

        await check("GET /tasks/:id/log for an unknown task is a 404", async () => {
          const response = await fetch(`${base}/tasks/no-such-task/log`, { headers: as("owner") });
          assert.equal(response.status, 404);
        });

        let served: TaskEvent[] = [];
        await check("GET /tasks/:id/log serves the service's log, never the workspace file", async () => {
          const response = await fetch(`${base}/tasks/${id}/log`, { headers: as("owner") });
          assert.equal(response.status, 200);
          assert.match(response.headers.get("content-type") ?? "", /application\/x-ndjson/);
          served = parseLog(await response.text());
          assertGapless(served);
          assert.ok(!served.some((event) => event.type === "intent_declared"));
          const file = eventLogFile(path.join(serverRoot, "data", "events"), id);
          assert.deepEqual(parseLog(await readFile(file, "utf8")), served);
          const fromWorkspace = path.relative(task.workspaceDir, file);
          assert.ok(fromWorkspace.startsWith(".."), `${file} is inside ${task.workspaceDir}`);
        });

        await check("the served log and the SSE replay are the same events", async () => {
          const response = await fetch(`${base}/tasks/${id}/events`, { headers: as("owner") });
          const streamed = (await response.text())
            .split("\n")
            .filter((line) => line.startsWith("data: "))
            .map((line) => JSON.parse(line.slice("data: ".length)) as TaskEvent);
          assert.ok(served.length > 0, "the previous check produced no log");
          assert.deepEqual(streamed, served);
        });

        await check("a log replaced by a junction is refused by the route", async () => {
          const outside = await outsideDirectory("route");
          const file = eventLogFile(path.join(serverRoot, "data", "events"), id);
          await rm(file);
          await junction(outside, file);
          const response = await fetch(`${base}/tasks/${id}/log`, { headers: as("owner") });
          assert.equal(response.status, 409);
          assert.doesNotMatch(await response.text(), /host secret/);
        });
      }
    } finally {
      child.kill();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    }
  }

  // ---------------------------------------------------------------- file tools

  {
    const workspace = path.join(root, "guard-workspace");
    const outside = await outsideDirectory("guard");
    await mkdir(path.join(workspace, "sub"), { recursive: true });
    await junction(outside, path.join(workspace, "linked"));
    await junction(path.join(workspace, "sub"), path.join(workspace, "inner"));
    const gone = path.join(root, "guard-gone");
    await mkdir(gone);
    await junction(gone, path.join(workspace, "dangling"));
    await rm(gone, { recursive: true });
    const policy = { workspaceDir: workspace, trustedReadRoots: [], agentBrowserToolAvailable: false };
    const decide = (tool: string, candidate: string) => checkToolCall(tool, { path: candidate }, policy);

    await check("every file tool refuses a path through a junction leading out", () => {
      for (const tool of ["read", "write", "edit", "ls", "grep", "find"]) {
        for (const candidate of [
          "linked",
          "linked/secret.txt",
          "linked/new.txt",
          path.join(workspace, "linked", "secret.txt"),
        ]) {
          const decision = decide(tool, candidate);
          assert.equal(decision?.block, true, `${tool} ${candidate} was allowed`);
          assert.match(decision?.reason ?? "", /symbolic link or junction/);
        }
      }
    });

    await check("a junction that stays inside the workspace is not refused", () => {
      assert.equal(decide("read", "inner/notes.txt"), undefined);
      assert.equal(decide("write", "inner/new.txt"), undefined);
    });

    await check("a dangling junction is refused, since its target is unknowable", () => {
      const decision = decide("write", "dangling/new.txt");
      assert.equal(decision?.block, true);
      assert.match(decision?.reason ?? "", /does not exist/);
    });

    await check("path prefixes the file tools expand are refused, behind a stripped @ too", () => {
      for (const candidate of [
        "~",
        "~/.ssh/id_rsa",
        "@../outside.txt",
        "@~/.ssh/id_rsa",
        "file:///etc/passwd",
        "@file:///etc/passwd",
        "FILE:///C:/Windows/win.ini",
      ]) {
        assert.equal(decide("read", candidate)?.block, true, `${candidate} was allowed`);
      }
    });

    await check("ordinary workspace paths still pass, with the one @ the tools strip", () => {
      for (const candidate of [
        "notes/a.txt",
        ".",
        "sub/../sub/a.txt",
        "notes/@mention.txt",
        "@notes/a.txt",
      ]) {
        assert.equal(decide("write", candidate), undefined, `${candidate} was refused`);
      }
    });

    // Names the tools reach from other text. Each is a junction out of the
    // workspace, asked for by a spelling that names nothing on disk, which the
    // guard used to judge as a new file inside the workspace.
    const fileTools = ["read", "write", "edit", "ls", "grep", "find"];
    const rewritten = [
      // Every file tool turns these Unicode spaces into an ASCII space.
      { link: "a b", asked: "a\u00A0b", tools: fileTools },
      { link: "c d", asked: "c\u2007d", tools: fileTools },
      { link: "e f", asked: "e\u3000f", tools: fileTools },
      // Only read falls back to macOS spellings of a path that does not exist.
      { link: "x\u2019y", asked: "x'y", tools: ["read"] },
      { link: "cafe\u0301", asked: "caf\u00E9", tools: ["read"] },
      { link: "shot\u202FAM.d", asked: "shot AM.d", tools: ["read"] },
    ];
    for (const { link } of rewritten) await junction(outside, path.join(workspace, link));
    const harness = await createPiHarness();

    await check("unguarded, Pi's own tools follow each rewritten spelling out of the workspace", async () => {
      // Not a guard check: proof that each case below is a live way out. If a
      // Pi upgrade stops a rewrite this fails, and the guard's copy of Pi's
      // rewriting is due a fresh comparison anyway (see check.ts).
      const raw = new Map(
        harness.createWorkspaceTools(workspace).map((tool) => [tool.name, tool as unknown as LooseTool]),
      );
      const run = async (tool: string, params: Record<string, unknown>) =>
        JSON.stringify(await raw.get(tool)!.execute(`raw-${tool}`, params));
      for (const { asked, tools } of rewritten) {
        assert.match(await run("read", { path: `${asked}/secret.txt` }), /host secret/, `read ${asked}`);
        if (!tools.includes("write")) continue;
        await run("write", { path: `${asked}/planted.txt`, content: "planted" });
        assert.ok((await readdir(outside)).includes("planted.txt"), `write ${asked} stayed inside`);
        await rm(path.join(outside, "planted.txt"));
        assert.match(await run("ls", { path: asked }), /secret\.txt/, `ls ${asked}`);
      }
    });

    await check("the guard refuses each rewritten spelling for every tool that follows it", () => {
      for (const { asked, tools } of rewritten) {
        const candidates = tools.includes("write")
          ? [asked, `${asked}/secret.txt`, `${asked}/new.txt`]
          : [asked, `${asked}/secret.txt`];
        for (const tool of tools) {
          for (const candidate of candidates) {
            const decision = decide(tool, candidate);
            assert.equal(decision?.block, true, `${tool} ${JSON.stringify(candidate)} was allowed`);
            assert.match(decision?.reason ?? "", /symbolic link or junction/);
          }
        }
      }
    });

    await check("a spelling only read falls back to is left alone for the other tools", () => {
      // write and ls open `x'y` as written, a new name inside the workspace.
      assert.equal(decide("write", "x'y/new.txt"), undefined);
      assert.equal(decide("ls", "caf\u00E9"), undefined);
    });

    await check("read asks about the other spellings only when the path as given does not exist", async () => {
      // As Pi does: `p'q/secret.txt` exists, so read opens it and never looks at
      // the same name behind the junction spelt with a curly apostrophe beside
      // it. Judging that one anyway is what refused every read under an
      // accented workspace path on macOS, where the NFD spelling of an existing
      // path always exists too.
      const elsewhere = await outsideDirectory("spelling-order");
      await writeFile(path.join(elsewhere, "only-outside.txt"), "host file");
      await mkdir(path.join(workspace, "p'q"));
      await writeFile(path.join(workspace, "p'q", "secret.txt"), "inside the workspace");
      await junction(elsewhere, path.join(workspace, "p\u2019q"));
      const rawRead = harness
        .createWorkspaceTools(workspace)
        .find((tool) => tool.name === "read") as unknown as LooseTool;
      const opened = JSON.stringify(await rawRead.execute("raw-order", { path: "p'q/secret.txt" }));
      assert.match(opened, /inside the workspace/, "Pi's read did not open the path as given");
      assert.equal(decide("read", "p'q/secret.txt")?.reason, undefined);
      // A name only the junction holds still falls back to it, and is refused.
      assert.equal(decide("read", "p'q/only-outside.txt")?.block, true);
    });

    if (process.platform !== "win32") {
      skip("a Git Bash drive path is judged where the tools open it", "Pi maps /c/... paths only on Windows");
    } else {
      await check("a Git Bash drive path is judged where the tools open it", () => {
        // `/c/x` is `C:\x` to the tools, and was `<current drive>:\c\x` to the guard.
        const gitBash = (native: string) =>
          `/${native[0]!.toLowerCase()}/${native.slice(3).replaceAll("\\", "/")}`;
        assert.equal(decide("write", gitBash(path.join(workspace, "notes", "a.txt"))), undefined);
        const escaping = decide("read", gitBash(path.join(workspace, "linked", "secret.txt")));
        assert.equal(escaping?.block, true);
        assert.match(escaping?.reason ?? "", /symbolic link or junction/);
      });
    }

    const symlinked = path.join(workspace, "secret-link.txt");
    const refusal = await fileSymlink(path.join(outside, "secret.txt"), symlinked);
    if (refusal !== undefined) {
      skip("read refuses a file symlink leading out of the workspace", refusal);
    } else {
      await check("read refuses a file symlink leading out of the workspace", () => {
        assert.equal(decide("read", "secret-link.txt")?.block, true);
      });
    }

    // The same refusals through a real session's bound guard, which is the path
    // a model's tool call takes.
    await check("the session's bound guard refuses the junction for the in-process tools", async () => {
      const model = harness.resolveModel(config.provider, config.model) ?? harness.anyModel();
      assert.ok(model, "no models in the catalogue to build a session with");
      const features = composeFeatures(featureContext(workspace), allToolNames, {
        maxCostUsd: config.maxCostUsd,
        maxToolResultChars: config.maxToolResultChars,
        maxToolResultCharsPerTurn: config.maxToolResultCharsPerTurn,
        getCurrentCostUsd: () => 0,
        onCostLimit: () => undefined,
      });
      const session = await harness.createSession({
        workspaceDir: workspace,
        agentDir: config.agentDir,
        model,
        thinkingLevel: config.thinking,
        toolNames: allToolNames,
        tools: [
          ...harness.createWorkspaceTools(workspace, {
            spawnHook: (context) => context,
            wrap: guardCommands,
          }),
          guardCommands(createHttpTool(config)),
        ],
        extensions: features.extensions,
        skillPaths: features.skillPaths,
        buildSystemPrompt: () =>
          buildSystemPrompt({
            workspaceDir: workspace,
            maxTurns: 1,
            maxWallClockMs: 1_000,
            featureSections: features.promptSections,
          }),
      });
      try {
        const wiring = session.inspect();
        for (const [tool, args] of [
          ["read", { path: "linked/secret.txt" }],
          ["write", { path: "linked/new.txt", content: "escaped" }],
          ["edit", { path: "linked/secret.txt", edits: [] }],
          ["ls", { path: "linked" }],
          ["read", { path: "a\u00A0b/secret.txt" }],
          ["write", { path: "a\u00A0b/new.txt", content: "escaped" }],
          ["read", { path: "x'y/secret.txt" }],
        ] as const) {
          const decision = await wiring.interceptToolCall(tool, { ...args });
          assert.equal(decision?.block, true, `${tool} ${JSON.stringify(args.path)} was allowed`);
        }
        assert.deepEqual(await readdir(outside), ["secret.txt"]);
      } finally {
        await session.inspect().emitShutdown();
        session.dispose();
      }
    });
  }

  // ------------------------------------------------- result and findings writes

  {
    const workspace = path.join(root, "write-workspace");
    const outside = await outsideDirectory("write");
    await mkdir(workspace, { recursive: true });
    const writeResult = (await featureTools(writeResultFeature, workspace)).get("write_result");
    const recordFinding = (await featureTools(findingsFeature, workspace)).get(RECORD_FINDING_TOOL_NAME);
    const verifyFinding = (await featureTools(verificationFeature, workspace)).get(VERIFY_FINDING_TOOL_NAME);
    assert.ok(writeResult && recordFinding && verifyFinding, "a write tool did not register");
    const envelope = { status: "success", summary: "ok", data: {}, steps: [] };

    await check("write_result refuses a result.json junction and writes nothing through it", async () => {
      const target = path.join(workspace, "result.json");
      await junction(outside, target);
      try {
        await assert.rejects(writeResult.execute("result-junction", envelope), /not a regular file/);
        assert.deepEqual(await readdir(outside), ["secret.txt"]);
        assert.equal((await lstat(target)).isSymbolicLink(), true, "the link should be left as found");
      } finally {
        await rm(target);
      }
    });

    await check("write_result ignores a link planted at the old fixed temp name", async () => {
      const planted = path.join(workspace, "result.json.tmp");
      await junction(outside, planted);
      try {
        await writeResult.execute("result-temp", envelope);
        const written = await lstat(path.join(workspace, "result.json"));
        assert.equal(written.isFile(), true);
        assert.deepEqual(JSON.parse(await readFile(path.join(workspace, "result.json"), "utf8")), envelope);
        assert.deepEqual(await readdir(outside), ["secret.txt"]);
        const leftovers = (await readdir(workspace)).filter(
          (entry) => entry.endsWith(".tmp") && entry !== "result.json.tmp",
        );
        assert.deepEqual(leftovers, [], "the random temp file should be renamed away");
      } finally {
        await rm(planted);
        await rm(path.join(workspace, "result.json"), { force: true });
      }
    });

    const resultLink = path.join(workspace, "result.json");
    const resultRefusal = await fileSymlink(path.join(outside, "secret.txt"), resultLink);
    if (resultRefusal !== undefined) {
      skip("write_result refuses a result.json symlink to a host file", resultRefusal);
    } else {
      await check("write_result refuses a result.json symlink to a host file", async () => {
        try {
          await assert.rejects(writeResult.execute("result-symlink", envelope), /not a regular file/);
          assert.match(await readFile(path.join(outside, "secret.txt"), "utf8"), /host secret/);
        } finally {
          await rm(resultLink);
        }
      });
    }

    for (const [label, file, tool, params] of [
      [
        RECORD_FINDING_TOOL_NAME,
        FINDINGS_FILE,
        recordFinding,
        {
          id: "lead-1",
          claim: "A claim.",
          confidence: "asserted",
          source: {
            kind: "url",
            locator: "https://example.invalid/1",
            retrievedAt: new Date().toISOString(),
            excerpt: "verbatim text",
          },
          fields: {},
        },
      ],
      [
        VERIFY_FINDING_TOOL_NAME,
        VERIFICATION_FILE,
        verifyFinding,
        { findingId: "lead-1", locatorFetched: false, evidence: "The page was gone." },
      ],
    ] as const) {
      await check(`${label} refuses a ${file} junction and writes nothing through it`, async () => {
        const target = path.join(workspace, file);
        await junction(outside, target);
        try {
          await assert.rejects(tool.execute(`${label}-junction`, params), /not a regular file/);
          assert.deepEqual(await readdir(outside), ["secret.txt"]);
        } finally {
          await rm(target);
        }
      });
    }
  }

  // --------------------------------------------------------------- readResult

  {
    const workspace = path.join(root, "read-workspace");
    const outside = await outsideDirectory("read");
    await mkdir(workspace, { recursive: true });
    const resultPath = path.join(workspace, "result.json");

    await check("readResult reads a regular result.json and reports a missing one as absent", async () => {
      assert.equal(await readResult(workspace), undefined);
      await writeFile(resultPath, '{"ok":true}');
      assert.deepEqual(await readResult(workspace), { ok: true });
      await rm(resultPath);
    });

    const refusedWith = (pattern: RegExp) => (error: unknown) =>
      error instanceof ResultRefused && pattern.test(error.message) && !/host secret/.test(error.message);

    await check("readResult refuses a result.json junction instead of following it", async () => {
      await junction(outside, resultPath);
      try {
        await assert.rejects(readResult(workspace), refusedWith(/never followed/));
      } finally {
        await rm(resultPath);
      }
    });

    await check("readResult refuses a directory named result.json", async () => {
      await mkdir(resultPath);
      try {
        await assert.rejects(readResult(workspace), refusedWith(/non-regular file/));
      } finally {
        await rm(resultPath, { recursive: true });
      }
    });

    const refusal = await fileSymlink(path.join(outside, "secret.txt"), resultPath);
    if (refusal !== undefined) {
      skip("readResult refuses a result.json symlink to a host file", refusal);
    } else {
      await check("readResult refuses a result.json symlink to a host file", async () => {
        try {
          await assert.rejects(readResult(workspace), refusedWith(/never followed/));
        } finally {
          await rm(resultPath);
        }
      });
    }

    await check("readResult reads a result at the size cap and refuses one past it", async () => {
      const exact = JSON.stringify({ pad: "x".repeat(MAX_RESULT_BYTES - '{"pad":""}'.length) });
      assert.equal(Buffer.byteLength(exact), MAX_RESULT_BYTES);
      await writeFile(resultPath, exact);
      assert.equal(((await readResult(workspace)) as { pad?: string }).pad?.length, exact.length - 10);
      await writeFile(resultPath, `${exact} `);
      await assert.rejects(
        readResult(workspace),
        (error: unknown) =>
          refusedWith(new RegExp(`${MAX_RESULT_BYTES}-byte`))(error) &&
          !(error as Error).message.includes("xxxx"),
      );
      await rm(resultPath);
    });

    // The same refusals through the runner, end to end from the queue. Only the
    // session is a stand-in, so no model is called: its prompt leaves result.json
    // the way a task's tools would. Everything after it is the production path.
    await check("a task whose result.json is refused fails, rather than completing", async () => {
      const real = await createPiHarness();
      const model = real.anyModel();
      assert.ok(model, "no models in the catalogue to resolve");
      const leaves: Record<string, (workspaceDir: string) => Promise<void>> = {
        valid: (dir) => writeFile(path.join(dir, "result.json"), '{"status":"success"}'),
        linked: (dir) => junction(outside, path.join(dir, "result.json")),
        oversized: (dir) =>
          writeFile(path.join(dir, "result.json"), JSON.stringify({ pad: "x".repeat(MAX_RESULT_BYTES) })),
      };
      const harness: AgentHarness = {
        ...real,
        resolveModel: () => model,
        createSession: async (spec) => ({
          subscribe: () => () => undefined,
          prompt: async (text) => await leaves[text]!(spec.workspaceDir),
          abort: async () => undefined,
          clearQueue: () => undefined,
          dispose: () => undefined,
          getStats: () => ({
            cost: 0,
            tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          }),
          isStreaming: false,
          hasToolCallInterception: () => true,
          shutdown: async () => undefined,
          inspect: () => {
            throw new Error("the stand-in session is not inspected");
          },
        }),
      };
      const store = new SQLiteTaskStore(path.join(root, "runner.db"));
      try {
        const queue = new TaskQueue({
          store,
          concurrency: 1,
          workspaceDirFor: (id) => path.join(root, "runner-workspaces", id),
          runner: createTaskRunner({
            config: { ...config, sandboxMode: "none", taskRuntimeDir: path.join(root, "runner-runtime") },
            harness,
          }),
        });
        const settle = async (prompt: string): Promise<TaskRecord> => {
          const { id } = queue.enqueue({ createdBy: "check", prompt });
          return await waitFor(() => {
            const task = store.get(id);
            return terminalStatuses.has(task?.status ?? "") ? task : undefined;
          }, `the ${prompt} task to settle`);
        };
        const valid = await settle("valid");
        assert.equal(valid.status, "completed", `the control task did not complete: ${valid.error}`);
        for (const prompt of ["linked", "oversized"]) {
          const task = await settle(prompt);
          assert.equal(task.status, "failed", `${prompt}: ${task.status}`);
          assert.equal(task.stoppedBy, "error", prompt);
          assert.match(task.error ?? "", /^result\.json /, prompt);
          assert.equal(task.result, undefined, `${prompt}: a refused result was kept`);
        }
        assert.deepEqual(await readdir(outside), ["secret.txt"]);
      } finally {
        store.close();
      }
    });
  }
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

console.log(failures === 0 ? "\nall integrity checks passed" : `\n${failures} integrity check(s) failed`);
process.exit(failures === 0 ? 0 : 1);

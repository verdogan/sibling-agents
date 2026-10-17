/**
 * Exercises the HTTP surface against a server that is already running:
 * auth, validation, task lifecycle, SSE streaming and cancellation.
 *
 * Tasks are expected to fail when no provider key is configured. What this
 * checks is the pipeline, not the agent's answer.
 */
import { config } from "../config.js";

const base = `http://${config.bindAddress === "0.0.0.0" ? "127.0.0.1" : config.bindAddress}:${config.port}`;
const authHeaders = { authorization: `Bearer ${config.token}`, "content-type": "application/json" };

let failures = 0;

function report(label: string, passed: boolean, detail = ""): void {
  console.log(`${passed ? "PASS" : "FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`);
  if (!passed) failures += 1;
}

async function post(pathname: string, body?: unknown, headers: Record<string, string> = authHeaders) {
  return fetch(`${base}${pathname}`, {
    method: "POST",
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const health = await fetch(`${base}/healthz`);
const healthBody = (await health.json()) as {
  provider?: string;
  models?: string[];
  skills?: string[];
  capabilities?: { inlineSkills?: { enabled?: boolean } };
};
report(
  "GET /healthz advertises worker profile capabilities",
  health.status === 200 &&
    healthBody.provider === config.provider &&
    healthBody.models?.includes(config.model) === true &&
    Array.isArray(healthBody.skills) &&
    typeof healthBody.capabilities?.inlineSkills?.enabled === "boolean",
  `status ${health.status}`,
);

const noAuth = await post("/tasks", { task: "noop" }, { "content-type": "application/json" });
report("POST /tasks without a token is rejected", noAuth.status === 401, `status ${noAuth.status}`);

const wrongToken = await post(
  "/tasks",
  { task: "noop" },
  { authorization: `Bearer ${"0".repeat(config.token.length)}`, "content-type": "application/json" },
);
report("POST /tasks with a wrong token is rejected", wrongToken.status === 401, `status ${wrongToken.status}`);

const emptyBody = await post("/tasks", {});
report("POST /tasks without a task string is a 400", emptyBody.status === 400, `status ${emptyBody.status}`);

const unknown = await fetch(`${base}/tasks/does-not-exist`, { headers: authHeaders });
report("GET an unknown task is a 404", unknown.status === 404, `status ${unknown.status}`);

// Per-task overrides: every rejection carries a message the caller can act on.
for (const [label, body] of [
  ["a misspelled option", { task: "noop", maxCost: 1 }],
  ["an unsupported thinking level", { task: "noop", thinking: "extreme" }],
  ["a budget above the server ceiling", { task: "noop", maxCostUsd: config.maxCostUsd + 1 }],
  ["an unknown tool name", { task: "noop", tools: ["read", "telepathy"] }],
  ["an unavailable model", { task: "noop", model: "gpt-does-not-exist" }],
  ["a mismatched provider", { task: "noop", provider: `${config.provider}-other` }],
  ["an unknown named skill", { task: "noop", skills: ["not-installed"] }],
] as Array<[string, Record<string, unknown>]>) {
  const response = await post("/tasks", body);
  const detail = ((await response.json()) as { error?: string }).error ?? "";
  report(`POST /tasks rejects ${label}`, response.status === 400, detail.slice(0, 110));
}

const escapedSeed = await post("/tasks", {
  task: "noop",
  files: { "../outside.txt": "must not be written" },
});
report(
  "POST /tasks rejects a seeded file outside the workspace",
  escapedSeed.status === 400,
  `status ${escapedSeed.status}`,
);

const seeded = await post("/tasks", {
  task: "noop",
  files: { "input/broken-recipe.json": "{}" },
  tools: ["read"],
  skills: ["browsing-rules"],
  maxTurns: 1,
});
const seededBody = (await seeded.json()) as { id?: string; seededFiles?: string[] };
report(
  "POST /tasks accepts and reports safe seeded files",
  seeded.status === 202 && seededBody.seededFiles?.[0] === "input/broken-recipe.json",
  JSON.stringify(seededBody.seededFiles ?? []),
);
if (seededBody.id !== undefined) {
  await new Promise((resolve) => setTimeout(resolve, 100));
  const listing = await fetch(`${base}/tasks/${seededBody.id}/artifacts`, {
    headers: authHeaders,
  });
  const listingBody = (await listing.json()) as {
    files?: Array<{ path?: string; sha256?: string }>;
  };
  const seededArtifact = listingBody.files?.find(
    (file) => file.path === "input/broken-recipe.json",
  );
  report(
    "artifact listing excludes seeded inputs",
    listing.status === 200 && seededArtifact === undefined,
    `status ${listing.status}`,
  );
  const fetched = await fetch(
    `${base}/tasks/${seededBody.id}/artifacts/file?${new URLSearchParams({
      path: "input/broken-recipe.json",
    })}`,
    { headers: authHeaders },
  );
  report(
    "artifact fetch refuses unlisted seeded inputs",
    fetched.status === 404,
    `status ${fetched.status}`,
  );
  const traversal = await fetch(
    `${base}/tasks/${seededBody.id}/artifacts/file?path=..%2Foutside.txt`,
    { headers: authHeaders },
  );
  const absolute = await fetch(
    `${base}/tasks/${seededBody.id}/artifacts/file?path=%2Fetc%2Fpasswd`,
    { headers: authHeaders },
  );
  report(
    "artifact fetch rejects traversal and absolute paths",
    traversal.status === 400 && absolute.status === 400,
    `traversal ${traversal.status}, absolute ${absolute.status}`,
  );
  await post(`/tasks/${seededBody.id}/cancel`).catch(() => undefined);
}

const keyedBody = {
  task: "This request is safely repeatable.",
  requestKey: `api-check-${Date.now()}`,
  maxTurns: 1,
  tools: ["read"],
};
const [keyedFirst, keyedSecond] = await Promise.all([
  post("/tasks", keyedBody, {
    ...authHeaders,
    "x-ling-caller": "forged-caller",
  }),
  post("/tasks", keyedBody),
]);
const keyedFirstBody = (await keyedFirst.json()) as { id?: string; requestKey?: string };
const keyedSecondBody = (await keyedSecond.json()) as { id?: string; requestKey?: string };
report(
  "requestKey deduplicates task creation",
  keyedFirst.status === 202 &&
    keyedSecond.status === 202 &&
    keyedFirstBody.id !== undefined &&
    keyedFirstBody.id === keyedSecondBody.id &&
    keyedSecondBody.requestKey === keyedBody.requestKey,
  `${keyedFirstBody.id ?? "missing"} / ${keyedSecondBody.id ?? "missing"}`,
);
if (keyedFirstBody.id !== undefined) await post(`/tasks/${keyedFirstBody.id}/cancel`);

if (keyedFirstBody.id !== undefined) {
  const attributed = await fetch(`${base}/tasks/${keyedFirstBody.id}`, {
    headers: authHeaders,
  });
  const attributedBody = (await attributed.json()) as { createdBy?: string };
  report(
    "verified credential identity ignores a forged caller header",
    attributed.status === 200 && attributedBody.createdBy === config.credentials[0]?.id,
    attributedBody.createdBy ?? "missing",
  );
}

const secondCredential = config.credentials[1];
if (secondCredential !== undefined && keyedFirstBody.id !== undefined) {
  const secondHeaders = {
    authorization: `Bearer ${secondCredential.token}`,
    "content-type": "application/json",
  };
  const namespaced = await post("/tasks", keyedBody, secondHeaders);
  const namespacedBody = (await namespaced.json()) as { id?: string };
  report(
    "request keys are namespaced by verified identity",
    namespaced.status === 202 &&
      namespacedBody.id !== undefined &&
      namespacedBody.id !== keyedFirstBody.id,
    `${keyedFirstBody.id} / ${namespacedBody.id ?? "missing"}`,
  );
  const crossRead = await fetch(`${base}/tasks/${keyedFirstBody.id}`, {
    headers: secondHeaders,
  });
  const crossArtifacts = await fetch(`${base}/tasks/${keyedFirstBody.id}/artifacts`, {
    headers: secondHeaders,
  });
  report(
    "one credential cannot read another caller's task or artifacts",
    crossRead.status === 404 && crossArtifacts.status === 404,
    `task ${crossRead.status}, artifacts ${crossArtifacts.status}`,
  );
  if (namespacedBody.id !== undefined) {
    await post(`/tasks/${namespacedBody.id}/cancel`, undefined, secondHeaders);
  }
}

const lowered = await post("/tasks", { task: "noop", maxTurns: 1, tools: ["write"] });
const loweredBody = (await lowered.json()) as { id?: string; options?: Record<string, unknown> };
report(
  "POST /tasks accepts overrides and echoes them back",
  lowered.status === 202 && loweredBody.options?.["maxTurns"] === 1,
  JSON.stringify(loweredBody.options ?? {}),
);
if (loweredBody.id !== undefined) await post(`/tasks/${loweredBody.id}/cancel`);

// Full lifecycle with SSE attached before the run finishes.
const created = await post("/tasks", {
  task: "Write result.json with status success and a one word summary.",
  tools: ["read", "write"],
  thinking: "low",
  maxTurns: 4,
  maxCostUsd: Math.min(0.25, config.maxCostUsd),
  instructions: "Answer from your own knowledge. Do not use the network.",
});
const createdBody = (await created.json()) as { id?: string };
const id = createdBody.id ?? "";
report("POST /tasks accepts a task", created.status === 202 && id !== "", `status ${created.status}`);

const seenEvents: string[] = [];
if (id !== "") {
  const stream = await fetch(`${base}/tasks/${id}/events`, { headers: authHeaders });
  report("SSE stream opens", stream.status === 200, `status ${stream.status}`);

  const reader = stream.body?.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + 90_000;

  while (reader && Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const line of decoder.decode(value).split("\n")) {
      if (line.startsWith("event: ")) seenEvents.push(line.slice("event: ".length).trim());
    }
    if (seenEvents.includes("task_finished") || seenEvents.includes("task_failed")) break;
  }
  await reader?.cancel().catch(() => undefined);

  report(
    "SSE delivered lifecycle events",
    seenEvents.includes("task_started") &&
      (seenEvents.includes("task_finished") || seenEvents.includes("task_failed")),
    seenEvents.join(",") || "none",
  );

  const finished = await fetch(`${base}/tasks/${id}`, { headers: authHeaders });
  const finishedBody = (await finished.json()) as { status?: string; error?: string };
  report(
    "task reached a terminal state",
    ["completed", "failed", "cancelled"].includes(finishedBody.status ?? ""),
    `status ${finishedBody.status}${finishedBody.error ? `, error: ${finishedBody.error.slice(0, 120)}` : ""}`,
  );

  const lateCancel = await post(`/tasks/${id}/cancel`);
  report("cancelling a finished task is a 409", lateCancel.status === 409, `status ${lateCancel.status}`);
}

// Cancel while still queued.
const toCancel = await post("/tasks", { task: "This one gets cancelled before it runs." });
const toCancelBody = (await toCancel.json()) as { id?: string };
if (toCancelBody.id !== undefined) {
  const cancel = await post(`/tasks/${toCancelBody.id}/cancel`);
  report("cancel is accepted", cancel.status === 202, `status ${cancel.status}`);
  const cancelDeadline = Date.now() + 10_000;
  let afterBody: { status?: string } = {};
  do {
    const after = await fetch(`${base}/tasks/${toCancelBody.id}`, { headers: authHeaders });
    afterBody = (await after.json()) as { status?: string };
    if (afterBody.status !== "queued" && afterBody.status !== "running") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < cancelDeadline);
  report(
    "cancelled task is not left running",
    afterBody.status === "cancelled" || afterBody.status === "failed",
    `status ${afterBody.status}`,
  );
}

console.log(failures === 0 ? "\nall API checks passed" : `\n${failures} API check(s) failed`);
process.exit(failures === 0 ? 0 : 1);

import path from "node:path";
import type { ArtifactClaim } from "./artifacts.js";
import type {
  AcceptanceCriterion,
  CampaignRole,
  CampaignVerdict,
  ReferenceBar,
} from "./schema.js";

export type WorkerResultStatus = "success" | "partial" | "failure";

export interface WorkerCheck {
  criterion: string;
  passed: boolean;
  evidence: string;
}

export interface WorkerBarFetch {
  ref: string;
  fetched: boolean;
  evidence: string;
}

export interface PlanWorkerResult {
  status: "success";
  summary: string;
  data: { kind: "plan"; artifacts: ArtifactClaim[] };
  steps: string[];
}

export interface BuildWorkerResult {
  status: "success" | "partial";
  summary: string;
  data: { kind: "build"; artifacts: ArtifactClaim[] };
  steps: string[];
}

export interface ReviewWorkerResult {
  status: "success" | "partial";
  summary: string;
  data: {
    kind: "review" | "integration";
    verdict: CampaignVerdict;
    checks: WorkerCheck[];
    evidence: string[];
    gaps: string[];
    barFetch: WorkerBarFetch | null;
  };
  steps: string[];
}

export type CampaignWorkerResult = PlanWorkerResult | BuildWorkerResult | ReviewWorkerResult;

export interface PlanSlice {
  id: string;
  path: string;
  dependsOn?: string[];
}

export interface PlanDocument {
  version: 1;
  slices: PlanSlice[];
}

export class WorkerResultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerResultError";
  }
}

function fail(location: string, message: string): never {
  throw new WorkerResultError(`${location}: ${message}`);
}

function object(value: unknown, location: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(location, "must be an object");
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
  if (unknown.length > 0) fail(location, `role-inappropriate or unknown field(s): ${unknown.join(", ")}`);
}

function string(value: unknown, location: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(location, "must be a non-empty string");
  return value;
}

function strings(value: unknown, location: string): string[] {
  if (!Array.isArray(value)) fail(location, "must be an array");
  return value.map((item, index) => string(item, `${location}[${index}]`));
}

function portableRelative(value: unknown, location: string): string {
  const parsed = string(value, location);
  const normalized = path.posix.normalize(parsed);
  if (
    parsed.includes("\\") ||
    path.posix.isAbsolute(parsed) ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized !== parsed
  ) {
    fail(location, "must be a normalized relative POSIX path");
  }
  return parsed;
}

function claims(value: unknown, location: string): ArtifactClaim[] {
  if (!Array.isArray(value) || value.length === 0) fail(location, "must contain at least one artifact");
  const seen = new Set<string>();
  return value.map((item, index) => {
    const claimLocation = `${location}[${index}]`;
    const raw = object(item, claimLocation);
    exactKeys(raw, ["path", "sha256"], claimLocation);
    const claimPath = portableRelative(raw["path"], `${claimLocation}.path`);
    if (seen.has(claimPath)) fail(`${claimLocation}.path`, "duplicates an earlier artifact");
    seen.add(claimPath);
    const result: ArtifactClaim = { path: claimPath };
    if (raw["sha256"] !== undefined) {
      const digest = string(raw["sha256"], `${claimLocation}.sha256`);
      if (!/^[a-f0-9]{64}$/.test(digest)) {
        fail(`${claimLocation}.sha256`, "must be a lowercase SHA-256 hex digest");
      }
      result.sha256 = digest;
    }
    return result;
  });
}

function checks(
  value: unknown,
  criteria: readonly AcceptanceCriterion[],
  location: string,
): WorkerCheck[] {
  if (!Array.isArray(value)) fail(location, "must be an array");
  const parsed = value.map((item, index) => {
    const checkLocation = `${location}[${index}]`;
    const raw = object(item, checkLocation);
    exactKeys(raw, ["criterion", "passed", "evidence"], checkLocation);
    if (typeof raw["passed"] !== "boolean") fail(`${checkLocation}.passed`, "must be a boolean");
    return {
      criterion: string(raw["criterion"], `${checkLocation}.criterion`),
      passed: raw["passed"],
      evidence: string(raw["evidence"], `${checkLocation}.evidence`),
    };
  });
  const expected = new Set(criteria.map((criterion) => criterion.id));
  const seen = new Set<string>();
  for (const check of parsed) {
    if (!expected.has(check.criterion)) {
      fail(location, `contains unknown criterion ${JSON.stringify(check.criterion)}`);
    }
    if (seen.has(check.criterion)) {
      fail(location, `contains duplicate criterion ${JSON.stringify(check.criterion)}`);
    }
    seen.add(check.criterion);
  }
  const missing = criteria.filter((criterion) => !seen.has(criterion.id)).map((criterion) => criterion.id);
  if (missing.length > 0) fail(location, `is missing criterion check(s): ${missing.join(", ")}`);
  return parsed;
}

function barFetch(value: unknown, bar: ReferenceBar | null, location: string): WorkerBarFetch | null {
  if (value === undefined || value === null) {
    if (bar !== null) fail(location, "is required when the campaign has a reference bar");
    return null;
  }
  if (bar === null) fail(location, "must be null when the campaign has no reference bar");
  const raw = object(value, location);
  exactKeys(raw, ["ref", "fetched", "evidence"], location);
  if (typeof raw["fetched"] !== "boolean") fail(`${location}.fetched`, "must be a boolean");
  const parsed = {
    ref: string(raw["ref"], `${location}.ref`),
    fetched: raw["fetched"],
    evidence: string(raw["evidence"], `${location}.evidence`),
  };
  if (parsed.ref !== bar.ref) fail(`${location}.ref`, "must match the campaign reference bar");
  return parsed;
}

function envelope(value: unknown): {
  status: WorkerResultStatus;
  summary: string;
  data: Record<string, unknown>;
  steps: string[];
} {
  const raw = object(value, "result");
  exactKeys(raw, ["status", "summary", "data", "steps"], "result");
  const status = raw["status"];
  if (status !== "success" && status !== "partial" && status !== "failure") {
    fail("result.status", "must be success, partial, or failure");
  }
  return {
    status,
    summary: string(raw["summary"], "result.summary"),
    data: object(raw["data"], "result.data"),
    steps: strings(raw["steps"], "result.steps"),
  };
}

export function parseWorkerResult(
  value: unknown,
  role: CampaignRole,
  criteria: readonly AcceptanceCriterion[],
  bar: ReferenceBar | null,
): CampaignWorkerResult {
  const parsed = envelope(value);
  if (parsed.status === "failure") {
    fail("result.status", `worker reported failure: ${parsed.summary}`);
  }

  if (role === "planner") {
    exactKeys(parsed.data, ["kind", "artifacts"], "result.data");
    if (parsed.data["kind"] !== "plan") fail("result.data.kind", "must be plan for a planner");
    if (parsed.status !== "success") fail("result.status", "a plan must report success");
    const artifacts = claims(parsed.data["artifacts"], "result.data.artifacts");
    if (!artifacts.some((claim) => claim.path === "plan.json")) {
      fail("result.data.artifacts", "must include plan.json");
    }
    return {
      status: "success",
      summary: parsed.summary,
      data: { kind: "plan", artifacts },
      steps: parsed.steps,
    };
  }

  if (role === "builder") {
    exactKeys(parsed.data, ["kind", "artifacts"], "result.data");
    if (parsed.data["kind"] !== "build") fail("result.data.kind", "must be build for a builder");
    const artifacts = claims(parsed.data["artifacts"], "result.data.artifacts");
    const reserved = artifacts.find((claim) =>
      ["campaign/", "accepted/", "proposal/", "reference-bar/"].some((prefix) =>
        claim.path.startsWith(prefix),
      ),
    );
    if (reserved !== undefined) {
      fail(
        "result.data.artifacts",
        `builder cannot claim seeded control or reference path ${JSON.stringify(reserved.path)}`,
      );
    }
    return {
      status: parsed.status,
      summary: parsed.summary,
      data: { kind: "build", artifacts },
      steps: parsed.steps,
    };
  }

  exactKeys(
    parsed.data,
    ["kind", "verdict", "checks", "evidence", "gaps", "barFetch"],
    "result.data",
  );
  const expectedKind = role === "reviewer" ? "review" : "integration";
  if (parsed.data["kind"] !== expectedKind) {
    fail("result.data.kind", `must be ${expectedKind} for a ${role}`);
  }
  const verdict = parsed.data["verdict"];
  if (verdict !== "accept" && verdict !== "revise" && verdict !== "blocked") {
    fail("result.data.verdict", "must be accept, revise, or blocked");
  }
  const parsedChecks = checks(parsed.data["checks"], criteria, "result.data.checks");
  const evidence = strings(parsed.data["evidence"], "result.data.evidence");
  const gaps = strings(parsed.data["gaps"], "result.data.gaps");
  const fetchedBar = barFetch(parsed.data["barFetch"], bar, "result.data.barFetch");

  if (verdict === "accept") {
    if (parsed.status !== "success") fail("result.status", "an accepted review must report success");
    if (parsedChecks.some((check) => !check.passed)) {
      fail("result.data.verdict", "cannot accept while an acceptance check failed");
    }
    if (gaps.length > 0) fail("result.data.gaps", "must be empty for an accepted review");
    if (fetchedBar !== null && !fetchedBar.fetched) {
      fail("result.data.verdict", "cannot accept when the reference bar was not fetched");
    }
  } else {
    if (gaps.length === 0) fail("result.data.gaps", `must be actionable for verdict ${verdict}`);
  }
  if (fetchedBar !== null && !fetchedBar.fetched && verdict !== "blocked") {
    fail("result.data.verdict", "must be blocked when the reference bar could not be fetched");
  }

  return {
    status: parsed.status,
    summary: parsed.summary,
    data: {
      kind: expectedKind,
      verdict,
      checks: parsedChecks,
      evidence,
      gaps,
      barFetch: fetchedBar,
    },
    steps: parsed.steps,
  };
}

export function parsePlanDocument(value: unknown): PlanDocument {
  const raw = object(value, "plan");
  exactKeys(raw, ["version", "slices"], "plan");
  if (raw["version"] !== 1) fail("plan.version", "must be 1");
  if (!Array.isArray(raw["slices"]) || raw["slices"].length === 0) {
    fail("plan.slices", "must contain at least one slice");
  }
  const seenIds = new Set<string>();
  const seenPaths = new Set<string>();
  const slices = raw["slices"].map((item, index) => {
    const location = `plan.slices[${index}]`;
    const slice = object(item, location);
    exactKeys(slice, ["id", "path", "dependsOn"], location);
    const id = string(slice["id"], `${location}.id`);
    const slicePath = portableRelative(slice["path"], `${location}.path`);
    if (!slicePath.startsWith("slices/") || !slicePath.endsWith(".md")) {
      fail(`${location}.path`, "must identify a Markdown file under slices/");
    }
    if (seenIds.has(id)) fail(`${location}.id`, "duplicates an earlier slice id");
    if (seenPaths.has(slicePath)) fail(`${location}.path`, "duplicates an earlier slice path");
    seenIds.add(id);
    seenPaths.add(slicePath);
    const parsed: PlanSlice = { id, path: slicePath };
    if (slice["dependsOn"] !== undefined) {
      const dependsOn = strings(slice["dependsOn"], `${location}.dependsOn`);
      if (dependsOn.includes(id)) fail(`${location}.dependsOn`, "cannot list its own slice");
      if (new Set(dependsOn).size !== dependsOn.length) {
        fail(`${location}.dependsOn`, "contains a duplicate slice id");
      }
      parsed.dependsOn = dependsOn;
    }
    return parsed;
  });
  const plannedIds = new Set(slices.map((slice) => slice.id));
  for (const [index, slice] of slices.entries()) {
    const unknown = (slice.dependsOn ?? []).filter((id) => !plannedIds.has(id));
    if (unknown.length > 0) {
      fail(`plan.slices[${index}].dependsOn`, `contains unknown slice id(s): ${unknown.join(", ")}`);
    }
  }
  return { version: 1, slices };
}

export function affectedSliceIds(gaps: readonly string[], knownSliceIds: readonly string[]): string[] {
  const known = new Set(knownSliceIds);
  const affected = new Set<string>();
  for (const gap of gaps) {
    for (const match of gap.matchAll(/\[slice:([^\]\s]+)\]/g)) {
      const id = match[1];
      if (id !== undefined && known.has(id)) affected.add(id);
    }
  }
  return [...affected];
}

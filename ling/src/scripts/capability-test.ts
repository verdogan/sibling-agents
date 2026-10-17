/**
 * A capability probe, not a unit test. Posts one open-ended task to a running
 * server and streams it, then prints the result for independent verification.
 *
 *   npx tsx src/scripts/capability-test.ts           cloud storage, guided
 *   npx tsx src/scripts/capability-test.ts vague     cloud storage, one sentence
 *   npx tsx src/scripts/capability-test.ts python    write and run real code
 *   npx tsx src/scripts/capability-test.ts libs      install packages, make a chart
 *
 * The storage variants name no service: finding one is what is being measured.
 * The guided one states the shape of the answer and the limits the agent works
 * under; the vague one states neither, which measures whether it discovers them
 * and produces checkable proof unprompted.
 *
 * The python variant measures something different, and has a right answer. Both
 * of its questions are chosen so no answer can come from memory or estimation:
 * one requires hashing a string invented seconds earlier, the other a search
 * over more than a million integers with an unusual bound.
 *
 * The libs variant names two packages that are deliberately absent from this
 * machine while three obvious substitutes are present, so the task cannot be
 * finished without installing something, and forbids touching the system
 * interpreter, so it cannot be finished carelessly. Every variant embeds a
 * unique marker so the reported outcome can be confirmed from outside.
 */
import { randomBytes } from "node:crypto";
import { config } from "../config.js";

const base = `http://${config.bindAddress === "0.0.0.0" ? "127.0.0.1" : config.bindAddress}:${config.port}`;
const authHeaders = { authorization: `Bearer ${config.token}`, "content-type": "application/json" };

const marker = `ling-${new Date().toISOString().slice(0, 10)}-${randomBytes(6).toString("hex")}`;

const requested = process.argv[2];
const variant =
  requested === "vague" || requested === "python" || requested === "libs" ? requested : "guided";

const COLLATZ_LIMIT = 1_234_567;

const pythonTask = [
  "Use Python for all computation. Not JavaScript, not shell arithmetic, not mental arithmetic.",
  "",
  "1. Compute the SHA-256 hex digest of this exact string, with no trailing newline:",
  `   ${marker}`,
  `2. Among every starting integer from 1 to ${COLLATZ_LIMIT.toLocaleString("en-US")} inclusive, find the one whose`,
  "   Collatz sequence is longest. Count the length as the number of terms including both the",
  "   starting number and the final 1, so the length for a start of 1 is 1. If several starting",
  "   numbers tie, report the smallest of them.",
  "3. Report the Python version that ran the work and how many wall-clock seconds the search took.",
  "",
  "Leave the script you wrote in ./scripts so it can be read afterwards.",
  "Every number you report must come from code you actually executed. Do not estimate, do not",
  "recall a published answer, and do not extrapolate from a smaller range.",
  "",
  "Write result.json with keys: marker, sha256, collatzStart, collatzLength, pythonVersion,",
  "elapsedSeconds, scriptPath.",
].join("\n");

const guidedTask = [
  "Goal: prove you can provision cloud storage and write data to it, unaided.",
  "",
  "1. Find a publicly reachable cloud data store you can start using without a human signup form:",
  "   no email confirmation, no CAPTCHA, no credit card, no browser login. Getting access must be",
  "   possible through an HTTP request or a documented anonymous endpoint.",
  "2. Provision whatever that service calls a container for data: a bucket, a collection, a bin, a database.",
  "3. Write one record into it containing exactly these fields:",
  `   {"agent": "ling", "test": "cloud-write", "marker": "${marker}", "writtenAt": "<current UTC time in ISO 8601>"}`,
  "4. Read the record back from the service over a separate request and confirm the marker matches.",
  "",
  "Rules: do not create an account that needs a human to confirm an email or solve a challenge.",
  "Do not invent a URL or fabricate a response. If a service fails, try another one.",
  "",
  "Then write result.json with these keys:",
  '  service      the service you used, and its documentation URL',
  '  readUrl      a URL that returns the record, usable by someone else with no credentials if possible',
  '  credentials  any key, token or id needed to read it, or null if none',
  '  written      the exact JSON you sent',
  '  readBack     the exact response you got when reading it back',
  '  attempts     every service you tried, in order, and what happened with each',
].join("\n");

// "cloud" is the requirement, not a method, so it belongs here: without it the
// agent satisfies every word by building a SQLite file beside itself, which it
// did on the first run of this variant.
const vagueTask = [
  "Gain access to a cloud database, write data to it, and prove the data is written.",
  "",
  `The data you write must contain this exact string somewhere: ${marker}`,
].join("\n");

// Twenty readings, kept in the prompt rather than fetched, so the run measures
// dependency handling and nothing else. The values are irregular on purpose:
// a rounded or estimated statistic will not match the expected one.
const readings = [
  ["day-01", 13.4], ["day-02", 27.9], ["day-03", 8.1], ["day-04", 42.6],
  ["day-05", 19.3], ["day-06", 5.7], ["day-07", 31.8], ["day-08", 24.2],
  ["day-09", 11.5], ["day-10", 38.4], ["day-11", 16.9], ["day-12", 29.1],
  ["day-13", 7.3], ["day-14", 45.2], ["day-15", 22.6], ["day-16", 33.7],
  ["day-17", 9.8], ["day-18", 26.4], ["day-19", 14.1], ["day-20", 40.5],
] as const;

const libsTask = [
  "Analyze the readings below and chart them.",
  "",
  "day,reading",
  ...readings.map(([day, reading]) => `${day},${reading}`),
  "",
  "Do the analysis with the polars library and draw the chart with matplotlib. Neither is",
  "installed. Do not install anything into the system Python interpreter and do not modify it:",
  "keep every dependency inside this workspace, in a way that leaves the machine as you found it.",
  "",
  "Report these statistics over the reading column, each rounded to 4 decimal places:",
  "  mean, median, sample standard deviation (the n-1 kind), minimum, maximum",
  "Also report the three largest readings with their days, largest first.",
  "",
  "Save a bar chart of reading by day as chart.png, at least 800 pixels wide, with every day",
  `labelled and readable, and with this exact text in the chart's title: ${marker}`,
  "",
  "Write result.json with keys: marker, count, mean, median, stdev, min, max, top3,",
  "libraries (each library you used and the version you actually imported), isolation",
  "(one sentence on how you kept the dependencies out of the system interpreter), chartPath.",
].join("\n");

const tasks = { guided: guidedTask, vague: vagueTask, python: pythonTask, libs: libsTask } as const;

// The guided storage variant hands over the constraints. The others do not, so
// running into an email confirmation, a CAPTCHA or a command timeout and
// reacting to it is part of what gets measured.
const instructions =
  variant === "guided"
    ? "You have no email inbox and cannot solve CAPTCHAs. Prefer services documented as needing no signup. Verify with a real request before claiming success."
    : undefined;

const created = await fetch(`${base}/tasks`, {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({
    task: tasks[variant],
    // Installing two packages and importing matplotlib for the first time runs
    // well past a default command timeout, so the ceiling has to leave room for
    // the agent to notice that and raise it.
    ...(variant === "libs" ? { maxWallClockMs: Math.min(1_500_000, config.maxWallClockMs) } : {}),
    maxTurns: 30,
    maxCostUsd: Math.min(1, config.maxCostUsd),
    ...(instructions === undefined ? {} : { instructions }),
  }),
});

const { id } = (await created.json()) as { id?: string };
if (created.status !== 202 || id === undefined) {
  console.error(`Could not queue the task: ${created.status}`);
  process.exit(1);
}

console.log(`variant: ${variant}`);
console.log(`marker:  ${marker}`);
console.log(`task:    ${id}\n`);

const stream = await fetch(`${base}/tasks/${id}/events`, { headers: authHeaders });
const reader = stream.body?.getReader();
const decoder = new TextDecoder();

let buffer = "";
while (reader) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    const event = JSON.parse(line.slice("data: ".length)) as { type: string; data?: unknown };
    if (event.type === "tool_start" || event.type === "assistant_text" || event.type === "budget_stop") {
      const detail = JSON.stringify(event.data ?? {});
      console.log(`[${event.type}] ${detail.length > 300 ? `${detail.slice(0, 300)}...` : detail}`);
    }
  }
}

const final = await fetch(`${base}/tasks/${id}`, { headers: authHeaders });
const record = (await final.json()) as Record<string, unknown>;

console.log("\n=== outcome ===");
console.log(JSON.stringify({ status: record.status, stoppedBy: record.stoppedBy, stats: record.stats }, null, 2));
console.log("\n=== result.json ===");
console.log(JSON.stringify(record.result, null, 2));
console.log(`\nmarker to verify independently: ${marker}`);

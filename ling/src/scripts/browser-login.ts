/**
 * One-time interactive login. Opens a real browser window, waits while you sign
 * in by hand, then saves cookies and localStorage to auth/<name>.json. Tasks
 * reuse that state by passing "storageState": "<name>" when they are created.
 *
 * Usage: npm run browser-login -- <name> [url]
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { chromium } from "playwright";
import { config } from "../config.js";
import { resolveInsideWorkspace } from "../guards.js";

const name = process.argv[2];
const startUrl = process.argv[3];

if (name === undefined || name.trim() === "") {
  console.error("Usage: npm run browser-login -- <name> [url]");
  process.exit(1);
}

const fileName = name.endsWith(".json") ? name : `${name}.json`;

// Confined the same way task-supplied names are, and before the browser opens,
// so a name containing a path separator fails immediately rather than after you
// have finished signing in.
let target: string;
try {
  target = resolveInsideWorkspace(config.authDir, fileName, "the auth directory");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

await mkdir(config.authDir, { recursive: true });

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();

if (startUrl !== undefined && startUrl.trim() !== "") {
  await page.goto(startUrl);
} else {
  console.log("No URL given; navigate to the login page yourself in the opened window.");
}

console.log(`\nA browser window is open. Sign in there, then come back here.`);
const rl = createInterface({ input: process.stdin, output: process.stdout });
await rl.question("Press Enter once you are logged in to save the session... ");
rl.close();

await context.storageState({ path: target });
await context.close();
await browser.close();

console.log(`\nSaved to ${target}`);
console.log(`Use it by posting a task with "storageState": "${name}".`);
console.log("Treat this file as a credential: it is gitignored, keep it that way.");

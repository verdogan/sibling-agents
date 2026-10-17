import { readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";

const terminalStatuses = new Set(["completed", "blocked", "budget_exhausted", "capped"]);

async function campaignDirectories(root: string): Promise<string[]> {
  const directManifest = path.join(root, "manifest.json");
  try {
    if ((await stat(directManifest)).isFile()) return [root];
  } catch {
    // Treat this as a parent of campaign directories.
  }
  const entries = await readdir(root, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name));
}

const roots = (
  process.argv.slice(2).length > 0
    ? process.argv.slice(2)
    : (process.env["CAMPAIGN_ROOTS"] ?? "").split(path.delimiter)
)
  .map((entry) => entry.trim())
  .filter((entry) => entry !== "")
  .map((entry) => path.resolve(entry));

if (roots.length === 0) {
  throw new Error(
    `Provide campaign roots as arguments or CAMPAIGN_ROOTS separated by ${JSON.stringify(path.delimiter)}.`,
  );
}

const retentionDays = Math.max(
  1,
  Number.parseInt(process.env["CAMPAIGN_ARTIFACT_RETENTION_DAYS"] ?? "90", 10) || 90,
);
const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
let pruned = 0;

for (const root of roots) {
  for (const directory of await campaignDirectories(root)) {
    try {
      const manifest = JSON.parse(
        await readFile(path.join(directory, "manifest.json"), "utf8"),
      ) as { status?: string; updatedAt?: string };
      const updatedAt = Date.parse(manifest.updatedAt ?? "");
      if (
        !terminalStatuses.has(manifest.status ?? "") ||
        !Number.isFinite(updatedAt) ||
        updatedAt >= cutoff
      ) {
        continue;
      }
      await rm(path.join(directory, "artifacts"), { recursive: true, force: true });
      await rm(path.join(directory, "progress.jsonl"), { force: true });
      pruned += 1;
    } catch {
      // Ignore non-campaign directories and malformed manifests; never delete
      // data whose retention eligibility cannot be proven.
    }
  }
}

console.log(`pruned artifact stores for ${pruned} expired campaign(s)`);

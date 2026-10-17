import { readFile } from "node:fs/promises";
import path from "node:path";
import { CampaignArtifactStore } from "../campaign/artifacts.js";
import { CampaignManifestStore } from "../campaign/manifest.js";
import {
  ObjectiveManifestStore,
  ProductSnapshotStore,
  initializeObjective,
} from "../objective/index.js";

function usage(): never {
  console.error(`Usage:
  npm run objective-snapshot -- init <objective-directory> <objective-id> <budget-usd> <statement>
  npm run objective-snapshot -- promote <objective.json> <campaign-manifest.json>
  npm run objective-snapshot -- status <objective.json>
  npm run objective-snapshot -- context <objective.json> <paths.json>`);
  process.exit(1);
}

function snapshotStore(
  objectiveFilename: string,
  campaignDirectory: string,
): ProductSnapshotStore {
  const objectiveStore = new ObjectiveManifestStore(objectiveFilename);
  const objectiveDirectory = path.dirname(path.resolve(objectiveFilename));
  const campaignRoot = path.resolve(campaignDirectory);
  return new ProductSnapshotStore(
    path.join(objectiveDirectory, "product"),
    objectiveStore,
    new CampaignArtifactStore(campaignRoot, path.join(campaignRoot, "workspaces")),
  );
}

const [, , command, ...args] = process.argv;

if (command === "init") {
  // The budget and the goal are required rather than defaulted: an objective's total
  // is the outer bound on everything it will ever spend, and there is no safe number
  // to invent on the principal's behalf.
  const [directory, id, budgetUsd, statement, ...extra] = args;
  if (!directory || !id || !budgetUsd || !statement || extra.length > 0) usage();
  const maxTotalCostUsd = Number(budgetUsd);
  if (!Number.isFinite(maxTotalCostUsd) || maxTotalCostUsd <= 0) {
    console.error(`Budget must be a positive number of dollars, got ${budgetUsd}.`);
    process.exit(1);
  }
  const filename = path.resolve(directory, "objective.json");
  const objective = await initializeObjective(new ObjectiveManifestStore(filename), {
    id,
    charter: { statement, budget: { maxTotalCostUsd, maxTotalTokens: null } },
  });
  console.log(`${objective.id}  ${filename}`);
} else if (command === "promote") {
  const [objectiveFilename, campaignFilename, ...extra] = args;
  if (!objectiveFilename || !campaignFilename || extra.length > 0) usage();
  const campaignPath = path.resolve(campaignFilename);
  const campaign = await new CampaignManifestStore(campaignPath).load();
  const promoted = await snapshotStore(
    path.resolve(objectiveFilename),
    path.dirname(campaignPath),
  ).promote(campaign);
  console.log(`${promoted.pointer.snapshotId}  ${promoted.manifest.files.length} file(s)`);
} else if (command === "status") {
  const [objectiveFilename, ...extra] = args;
  if (!objectiveFilename || extra.length > 0) usage();
  const objective = await new ObjectiveManifestStore(path.resolve(objectiveFilename)).load();
  console.log(JSON.stringify(objective, null, 2));
} else if (command === "context") {
  const [objectiveFilename, pathsFilename, ...extra] = args;
  if (!objectiveFilename || !pathsFilename || extra.length > 0) usage();
  const parsed = JSON.parse(await readFile(path.resolve(pathsFilename), "utf8")) as unknown;
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new TypeError("Context paths JSON must be an array of strings.");
  }
  const selected = await snapshotStore(
    path.resolve(objectiveFilename),
    path.dirname(path.resolve(objectiveFilename)),
  ).selectContext(parsed);
  console.log(JSON.stringify(selected, null, 2));
} else {
  usage();
}

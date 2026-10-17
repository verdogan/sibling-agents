import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  ArtifactTransportError,
  CampaignArtifactStore,
  MAX_CAMPAIGN_SEED_FILES,
  MAX_CAMPAIGN_SEED_PATH_CHARS,
  artifactRedactorFromEnv,
  artifactSourcePath,
  type ArtifactRedactor,
} from "../campaign/artifacts.js";
import {
  parseCampaignManifest,
  type ArtifactRef,
  type CampaignManifest,
} from "../campaign/schema.js";
import { ObjectiveManifestStore } from "./manifest.js";
import {
  MAX_PRODUCT_SNAPSHOT_FILES,
  MAX_PRODUCT_SNAPSHOT_MANIFEST_BYTES,
  PRODUCT_SNAPSHOT_VERSION,
  parseProductPath,
  parseProductSnapshotManifest,
  parseProductSnapshotPointer,
  type ObjectiveManifest,
  type ProductSnapshotManifest,
  type ProductSnapshotPointer,
} from "./schema.js";

export type ProductSnapshotErrorCode =
  | "campaign_incomplete"
  | "collision"
  | "integrity"
  | "invalid_path"
  | "limit"
  | "missing";

export class ProductSnapshotError extends Error {
  constructor(
    message: string,
    readonly code: ProductSnapshotErrorCode,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProductSnapshotError";
  }
}

export interface ProductSnapshotPromotion {
  manifest: ProductSnapshotManifest;
  pointer: ProductSnapshotPointer;
  objective: ObjectiveManifest;
}

interface PromotedArtifact {
  sourcePath: string;
  ref: ArtifactRef;
}

/**
 * Owns immutable, fully materialized product snapshots. Snapshot blobs are
 * rooted separately from campaign storage, so campaign retention cannot make a
 * promoted product unreadable.
 */
export class ProductSnapshotStore {
  readonly rootDir: string;
  readonly objectiveArtifacts: CampaignArtifactStore;

  constructor(
    rootDir: string,
    private readonly objectiveStore: ObjectiveManifestStore,
    private readonly campaignArtifacts: CampaignArtifactStore,
    private readonly redact: ArtifactRedactor = artifactRedactorFromEnv(),
  ) {
    this.rootDir = path.resolve(rootDir);
    this.objectiveArtifacts = new CampaignArtifactStore(this.rootDir, this.rootDir);
  }

  async promote(campaignValue: CampaignManifest | unknown): Promise<ProductSnapshotPromotion> {
    const campaign = parseCampaignManifest(campaignValue);
    if (campaign.status !== "completed") {
      throw new ProductSnapshotError(
        `Campaign ${JSON.stringify(campaign.id)} is ${campaign.status}; only completed campaigns can be promoted.`,
        "campaign_incomplete",
      );
    }

    // Capture the CAS token and parent before doing any immutable writes.
    const objective = await this.objectiveStore.load();
    let parent: ProductSnapshotManifest | null = null;
    if (objective.currentProductSnapshot !== null) {
      parent = await this.load(objective.currentProductSnapshot);
      if (parent.objectiveId !== objective.id) {
        throw new ProductSnapshotError(
          `Snapshot ${objective.currentProductSnapshot.snapshotId} belongs to objective ${JSON.stringify(parent.objectiveId)}, not ${JSON.stringify(objective.id)}.`,
          "integrity",
        );
      }
    }

    // Resolve every source path before copying anything. No precedence exists
    // between two artifacts accepted by the same campaign.
    const promoted = this.latestAcceptedArtifacts(campaign);
    const projectedPaths = new Set((parent?.files ?? []).map((file) => file.path));
    for (const item of promoted) projectedPaths.add(item.sourcePath);
    if (projectedPaths.size > MAX_PRODUCT_SNAPSHOT_FILES) {
      throw new ProductSnapshotError(
        `Promotion would create ${projectedPaths.size} product files; the snapshot limit is ${MAX_PRODUCT_SNAPSHOT_FILES}.`,
        "limit",
      );
    }
    const files = new Map(
      (parent?.files ?? []).map((file) => [file.path, structuredClone(file.artifact)]),
    );
    for (const item of promoted) {
      const verifiedText = await this.campaignArtifacts.readText(item.ref);
      const copied = await this.objectiveArtifacts.storeText(
        "product",
        item.sourcePath,
        this.redact(verifiedText),
      );
      await this.syncObjectiveArtifact(copied);
      files.set(item.sourcePath, copied);
    }

    const manifest = parseProductSnapshotManifest({
      version: PRODUCT_SNAPSHOT_VERSION,
      objectiveId: objective.id,
      parent: objective.currentProductSnapshot,
      campaignId: campaign.id,
      campaignUpdatedAt: campaign.updatedAt,
      createdAt: new Date().toISOString(),
      files: [...files.entries()]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([filePath, artifact]) => ({ path: filePath, artifact })),
    });
    const pointer = await this.writeImmutableManifest(manifest);

    // This is the only mutable write. A crash or failure before it leaves the
    // previous pointer untouched; a competing promotion makes this CAS fail.
    const advanced = await this.objectiveStore.compareAndSwapProductSnapshot(
      objective,
      pointer,
    );
    return { manifest, pointer, objective: advanced };
  }

  async load(pointerValue: ProductSnapshotPointer | unknown): Promise<ProductSnapshotManifest> {
    const pointer = parseProductSnapshotPointer(pointerValue);
    const filename = this.resolveOwnedPath(pointer.path);
    let size: number;
    try {
      size = (await stat(filename)).size;
    } catch (error) {
      throw new ProductSnapshotError(
        `Product snapshot ${pointer.snapshotId} is unavailable.`,
        "missing",
        { cause: error },
      );
    }
    if (size > MAX_PRODUCT_SNAPSHOT_MANIFEST_BYTES) {
      throw new ProductSnapshotError(
        `Product snapshot ${pointer.snapshotId} exceeds the ${MAX_PRODUCT_SNAPSHOT_MANIFEST_BYTES}-byte manifest limit.`,
        "limit",
      );
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(filename);
    } catch (error) {
      throw new ProductSnapshotError(
        `Product snapshot ${pointer.snapshotId} is unavailable.`,
        "missing",
        { cause: error },
      );
    }
    if (bytes.byteLength > MAX_PRODUCT_SNAPSHOT_MANIFEST_BYTES) {
      throw new ProductSnapshotError(
        `Product snapshot ${pointer.snapshotId} changed beyond the manifest size limit while reading.`,
        "limit",
      );
    }
    const actual = digest(bytes);
    if (actual !== pointer.sha256) {
      throw new ProductSnapshotError(
        `Product snapshot ${pointer.snapshotId} failed its SHA-256 integrity check.`,
        "integrity",
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      throw new ProductSnapshotError(
        `Product snapshot ${pointer.snapshotId} is not valid JSON.`,
        "integrity",
        { cause: error },
      );
    }
    return parseProductSnapshotManifest(value);
  }

  async loadCurrent(): Promise<ProductSnapshotManifest | null> {
    const objective = await this.objectiveStore.load();
    if (objective.currentProductSnapshot === null) return null;
    const manifest = await this.load(objective.currentProductSnapshot);
    if (manifest.objectiveId !== objective.id) {
      throw new ProductSnapshotError(
        `Current product snapshot belongs to objective ${JSON.stringify(manifest.objectiveId)}, not ${JSON.stringify(objective.id)}.`,
        "integrity",
      );
    }
    return manifest;
  }

  /**
   * Selects exact product paths; globbing and implicit "all files" selection
   * are intentionally absent. Returned keys retain their original paths.
   */
  async selectContext(
    paths: readonly string[],
    pointerValue?: ProductSnapshotPointer,
  ): Promise<Record<string, string>> {
    if (paths.length === 0 || paths.length > MAX_CAMPAIGN_SEED_FILES) {
      throw new ArtifactTransportError(
        `Product context must select between 1 and ${MAX_CAMPAIGN_SEED_FILES} paths; got ${paths.length}.`,
        "too_many_files",
      );
    }
    const selectedPaths = paths.map((value, index) => {
      const parsed = parseProductPath(value, `Product context paths[${index}]`);
      if (parsed.length > MAX_CAMPAIGN_SEED_PATH_CHARS) {
        throw new ArtifactTransportError(
          `Product context path ${JSON.stringify(parsed)} exceeds ${MAX_CAMPAIGN_SEED_PATH_CHARS} characters.`,
          "invalid_path",
        );
      }
      return parsed;
    });
    const seen = new Set<string>();
    for (const selectedPath of selectedPaths) {
      if (seen.has(selectedPath)) {
        throw new ArtifactTransportError(
          `Product context selects ${selectedPath} more than once.`,
          "collision",
        );
      }
      seen.add(selectedPath);
    }

    let pointer = pointerValue;
    if (pointer === undefined) {
      const objective = await this.objectiveStore.load();
      pointer = objective.currentProductSnapshot ?? undefined;
      if (pointer === undefined) {
        throw new ProductSnapshotError(
          `Objective ${JSON.stringify(objective.id)} has no current product snapshot.`,
          "missing",
        );
      }
    }
    const snapshot = await this.load(pointer);
    const byPath = new Map(snapshot.files.map((file) => [file.path, file.artifact]));
    return this.objectiveArtifacts.seedArtifacts(
      selectedPaths.map((selectedPath) => {
        const ref = byPath.get(selectedPath);
        if (ref === undefined) {
          throw new ProductSnapshotError(
            `Product snapshot ${pointer.snapshotId} does not contain ${JSON.stringify(selectedPath)}.`,
            "missing",
          );
        }
        return { path: selectedPath, ref };
      }),
    );
  }

  private latestAcceptedArtifacts(campaign: CampaignManifest): PromotedArtifact[] {
    const bySourcePath = new Map<string, ArtifactRef>();
    for (const slice of campaign.slices) {
      const accepted = [...slice.attempts]
        .reverse()
        .find((attempt) => attempt.verdict === "accept");
      if (accepted === undefined) {
        // parseCampaignManifest normally makes this unreachable for completed campaigns.
        throw new ProductSnapshotError(
          `Completed campaign slice ${JSON.stringify(slice.id)} has no accepted attempt.`,
          "campaign_incomplete",
        );
      }
      for (const ref of accepted.artifacts) {
        let sourcePath: string;
        try {
          sourcePath = parseProductPath(
            artifactSourcePath(ref),
            `Campaign artifact ${ref.path} source path`,
          );
        } catch (error) {
          throw new ProductSnapshotError(
            `Campaign artifact ${ref.path} does not have a usable original source path.`,
            "invalid_path",
            { cause: error },
          );
        }
        if (bySourcePath.has(sourcePath)) {
          throw new ProductSnapshotError(
            `Completed campaign maps multiple accepted artifacts to ${JSON.stringify(sourcePath)}; promotion precedence would be ambiguous.`,
            "collision",
          );
        }
        bySourcePath.set(sourcePath, ref);
      }
    }
    return [...bySourcePath.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([sourcePath, ref]) => ({ sourcePath, ref }));
  }

  private async writeImmutableManifest(
    manifestValue: ProductSnapshotManifest,
  ): Promise<ProductSnapshotPointer> {
    const manifest = parseProductSnapshotManifest(manifestValue);
    const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const sha256 = digest(bytes);
    const pointer = parseProductSnapshotPointer({
      snapshotId: `sha256:${sha256}`,
      path: `snapshots/${sha256}.json`,
      sha256,
    });
    const filename = this.resolveOwnedPath(pointer.path);
    await writeImmutable(filename, bytes);
    return pointer;
  }

  private async syncObjectiveArtifact(ref: ArtifactRef): Promise<void> {
    const filename = this.resolveOwnedPath(ref.path);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      // Windows requires a writable handle for FlushFileBuffers/fsync.
      handle = await open(filename, "r+");
      await handle.sync();
    } catch (error) {
      throw new ProductSnapshotError(
        `Unable to make objective artifact ${ref.path} durable.`,
        "missing",
        { cause: error },
      );
    } finally {
      await handle?.close();
    }
    await syncDirectory(path.dirname(filename));
  }

  private resolveOwnedPath(relativePath: string): string {
    const portable = parseProductPath(relativePath, "Objective-owned path");
    const resolved = path.resolve(this.rootDir, ...portable.split("/"));
    const relative = path.relative(this.rootDir, resolved);
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new ProductSnapshotError(
        `Objective-owned path ${JSON.stringify(relativePath)} escapes ${this.rootDir}.`,
        "invalid_path",
      );
    }
    return resolved;
  }
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function writeImmutable(filename: string, bytes: Uint8Array): Promise<void> {
  const directory = path.dirname(filename);
  await mkdir(directory, { recursive: true });
  const temporary = path.join(
    directory,
    `.${path.basename(filename)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw new ProductSnapshotError(
      `Unable to stage immutable product snapshot ${filename}.`,
      "missing",
      { cause: error },
    );
  } finally {
    await handle?.close();
  }

  try {
    await link(temporary, filename);
    await rm(temporary);
    await syncDirectory(directory);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      const existing = await readFile(filename).catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
      if (existing !== undefined && existing.equals(Buffer.from(bytes))) return;
    } else {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
    throw new ProductSnapshotError(
      `Unable to persist immutable product snapshot ${filename}.`,
      "integrity",
      { cause: error },
    );
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (process.platform !== "win32") throw error;
  } finally {
    await handle?.close();
  }
}

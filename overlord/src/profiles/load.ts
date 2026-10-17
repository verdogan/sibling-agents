import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ProfileLibrary } from "./library.js";
import type { ResolvedProfile } from "./types.js";

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function resolvedProfileHash(profile: ResolvedProfile): string {
  return createHash("sha256").update(canonicalJson(profile), "utf8").digest("hex");
}

export async function loadProfileLibrary(filename: string): Promise<ProfileLibrary> {
  const resolved = path.resolve(filename);
  let json: string;
  try {
    json = await readFile(resolved, "utf8");
  } catch (error) {
    throw new Error(`Unable to read profile catalogue ${resolved}.`, { cause: error });
  }
  try {
    return ProfileLibrary.fromJson(json);
  } catch (error) {
    throw new Error(`Unable to load profile catalogue ${resolved}.`, { cause: error });
  }
}

export async function profileLibraryFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProfileLibrary | undefined> {
  const filename = env["OVERLORD_PROFILE_LIBRARY"]?.trim();
  return filename ? loadProfileLibrary(filename) : undefined;
}

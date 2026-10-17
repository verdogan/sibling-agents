import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { resolveInsideWorkspace } from "../guards.js";
import type { MonitorItemInput } from "./types.js";

export type RecipeWait =
  | { kind: "load"; value: "load" | "domcontentloaded" | "networkidle" }
  | { kind: "text"; value: string }
  | { kind: "selector"; value: string }
  | { kind: "milliseconds"; value: number };

export interface MonitorRecipe {
  version: 1;
  id: string;
  platform: string;
  requiresAuth: false;
  searchUrlTemplate: string;
  allowedDomains: string[];
  wait: RecipeWait;
  extractor: string;
  maxItems: number;
  createdAt: string;
  agentBrowserVersion: string;
  sample: Array<{
    sourceId: string;
    url: string;
    author: string | null;
    text: string;
    createdAt: string | null;
  }>;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, label: string, max = 100_000): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) {
    throw new Error(`${label} must be a non-empty string no longer than ${max} characters`);
  }
  return value;
}

function validateWait(value: unknown): RecipeWait {
  const wait = object(value, "recipe.wait");
  const kind = wait["kind"];
  if (kind === "load") {
    const state = wait["value"];
    if (state !== "load" && state !== "domcontentloaded" && state !== "networkidle") {
      throw new Error("recipe.wait.value must be load, domcontentloaded, or networkidle");
    }
    return { kind, value: state };
  }
  if (kind === "text" || kind === "selector") {
    return { kind, value: nonEmptyString(wait["value"], "recipe.wait.value", 500) };
  }
  if (kind === "milliseconds") {
    const milliseconds = wait["value"];
    if (
      typeof milliseconds !== "number" ||
      !Number.isInteger(milliseconds) ||
      milliseconds < 0 ||
      milliseconds > 10_000
    ) {
      throw new Error("recipe.wait.value must be an integer between 0 and 10000");
    }
    return { kind, value: milliseconds };
  }
  throw new Error("recipe.wait.kind must be load, text, selector, or milliseconds");
}

export function validateExtractedItems(
  value: unknown,
  recipe: Pick<MonitorRecipe, "platform" | "maxItems">,
  query: string,
): MonitorItemInput[] {
  if (!Array.isArray(value)) throw new Error("recipe extractor must return an array");
  if (value.length > recipe.maxItems) {
    throw new Error(`recipe extractor returned ${value.length} items, above its cap of ${recipe.maxItems}`);
  }

  return value.map((entry, index) => {
    const item = object(entry, `extractor item ${index}`);
    const sourceId = nonEmptyString(item["sourceId"], `item ${index}.sourceId`, 500);
    const url = nonEmptyString(item["url"], `item ${index}.url`, 4000);
    const text = nonEmptyString(item["text"], `item ${index}.text`, 50_000);
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw new Error(`item ${index}.url must use http or https`);
    }
    const author = item["author"];
    const createdAt = item["createdAt"];
    if (author !== null && author !== undefined && typeof author !== "string") {
      throw new Error(`item ${index}.author must be a string or null`);
    }
    if (createdAt !== null && createdAt !== undefined && typeof createdAt !== "string") {
      throw new Error(`item ${index}.createdAt must be an ISO string or null`);
    }
    if (typeof createdAt === "string" && Number.isNaN(Date.parse(createdAt))) {
      throw new Error(`item ${index}.createdAt is not a valid date`);
    }
    return {
      platform: recipe.platform,
      sourceId,
      url,
      author: typeof author === "string" ? author : null,
      text,
      createdAt: typeof createdAt === "string" ? new Date(createdAt).toISOString() : null,
      query,
      raw: entry,
    };
  });
}

export function validateRecipe(value: unknown): MonitorRecipe {
  const raw = object(value, "recipe");
  if (raw["version"] !== 1) throw new Error("recipe.version must be 1");
  if (raw["requiresAuth"] !== false) throw new Error("recipe.requiresAuth must be false in this phase");

  const id = nonEmptyString(raw["id"], "recipe.id", 100);
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id)) {
    throw new Error("recipe.id may contain only letters, numbers, hyphens, and underscores");
  }
  const platform = nonEmptyString(raw["platform"], "recipe.platform", 100);
  const searchUrlTemplate = nonEmptyString(
    raw["searchUrlTemplate"],
    "recipe.searchUrlTemplate",
    4000,
  );
  if (!searchUrlTemplate.includes("{{query}}")) {
    throw new Error("recipe.searchUrlTemplate must contain {{query}}");
  }
  const testUrl = new URL(searchUrlTemplate.replaceAll("{{query}}", "test"));
  if (testUrl.protocol !== "https:" && testUrl.protocol !== "http:") {
    throw new Error("recipe.searchUrlTemplate must be an http or https URL");
  }

  if (!Array.isArray(raw["allowedDomains"]) || raw["allowedDomains"].length === 0) {
    throw new Error("recipe.allowedDomains must be a non-empty array");
  }
  const allowedDomains = raw["allowedDomains"].map((domain, index) => {
    const result = nonEmptyString(domain, `recipe.allowedDomains[${index}]`, 255).toLowerCase();
    if (result.includes("/") || result.includes(":") || !/^(\*\.)?[a-z0-9.-]+$/.test(result)) {
      throw new Error(`recipe.allowedDomains[${index}] is not a hostname or wildcard hostname`);
    }
    return result;
  });

  const maxItems = raw["maxItems"];
  if (typeof maxItems !== "number" || !Number.isInteger(maxItems) || maxItems < 1 || maxItems > 100) {
    throw new Error("recipe.maxItems must be an integer between 1 and 100");
  }
  const createdAt = nonEmptyString(raw["createdAt"], "recipe.createdAt", 100);
  if (Number.isNaN(Date.parse(createdAt))) throw new Error("recipe.createdAt must be an ISO date");
  const agentBrowserVersion = nonEmptyString(
    raw["agentBrowserVersion"],
    "recipe.agentBrowserVersion",
    100,
  );
  const extractor = nonEmptyString(raw["extractor"], "recipe.extractor", 100_000);
  if (extractor.includes("fetch(") || extractor.includes("XMLHttpRequest")) {
    throw new Error("recipe.extractor must only inspect the rendered DOM, not make network requests");
  }

  const recipe: MonitorRecipe = {
    version: 1,
    id,
    platform,
    requiresAuth: false,
    searchUrlTemplate,
    allowedDomains,
    wait: validateWait(raw["wait"]),
    extractor,
    maxItems,
    createdAt: new Date(createdAt).toISOString(),
    agentBrowserVersion,
    sample: [],
  };
  recipe.sample = validateExtractedItems(raw["sample"], recipe, "__sample__").map((item) => ({
    sourceId: item.sourceId,
    url: item.url,
    author: item.author,
    text: item.text,
    createdAt: item.createdAt,
  }));
  return recipe;
}

export function recipePath(id: string): string {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id)) throw new Error(`Invalid recipe id: ${id}`);
  return resolveInsideWorkspace(config.recipesDir, `${id}.json`, "the recipe directory");
}

export async function loadRecipe(idOrPath: string): Promise<MonitorRecipe> {
  const target = idOrPath.endsWith(".json")
    ? resolveInsideWorkspace(config.recipesDir, idOrPath, "the recipe directory")
    : recipePath(idOrPath);
  return validateRecipe(JSON.parse(await readFile(target, "utf8")) as unknown);
}

export async function saveRecipe(value: unknown): Promise<MonitorRecipe> {
  const recipe = validateRecipe(value);
  await mkdir(config.recipesDir, { recursive: true });
  await writeFile(recipePath(recipe.id), `${JSON.stringify(recipe, null, 2)}\n`, "utf8");
  return recipe;
}

export function renderSearchUrl(recipe: MonitorRecipe, query: string): string {
  const rendered = recipe.searchUrlTemplate.replaceAll("{{query}}", encodeURIComponent(query));
  const url = new URL(rendered);
  const hostAllowed = recipe.allowedDomains.some((pattern) => {
    const bare = pattern.startsWith("*.") ? pattern.slice(2) : pattern;
    return url.hostname === bare || (pattern.startsWith("*.") && url.hostname.endsWith(`.${bare}`));
  });
  if (!hostAllowed) throw new Error(`Recipe ${recipe.id} search URL is outside its allowed domains`);
  return url.href;
}

/**
 * A batch's model pins, as a paid run's child ling resolves its model.
 *
 * The beforePost check (run.ts resolvedModelMismatch) compares each openrouter child's /healthz
 * model with its pin: provider, id, thinking, every price, every compat field with the routing, and
 * the thinking level. So a pin is built the way the child builds that record: Pi's catalogue entry
 * for the model (the child's agent directory is empty, so it is the installed catalogue and nothing
 * else), with LING_MODEL_ROUTING's entry added to its compat as ling's routeModel adds it, and read
 * the way ling's describeModel reads it.
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { BatchModel, ModelRouting, ModelRoutingEntry } from "../records.js";

/** The only provider whose requests carry OpenRouter's routing (ling's ROUTING_PROVIDER). */
export const ROUTING_PROVIDER = "openrouter";

/** What the owner decided for one role: the model, its one upstream provider, and its thinking level. */
export interface PinSpec {
  model: string;
  /** OpenRouter's provider slug, lower case (`z-ai`), never the model id. */
  slug: string;
  /** OpenRouter's display name for that provider (`Z.AI`), as served calls report it. */
  servedProviderName: string;
  thinking: string;
  /** The pinned endpoint's output ceiling (OpenRouter's max_completion_tokens), when known. */
  maxTokens?: number;
}

/** The pilot's decided pins (owner, 2026-10-07): GLM on Z.AI and terra on OpenAI, both at thinking low. */
export const PILOT_PIN_SPECS: { a: PinSpec; b: PinSpec } = {
  a: { model: "z-ai/glm-5.3-flash", slug: "z-ai", servedProviderName: "Z.AI", thinking: "low" },
  b: { model: "openai/gpt-5.6-terra", slug: "openai", servedProviderName: "OpenAI", thinking: "low" },
};

/** The parts of a Pi catalogue model a pin reads. */
export interface CatalogueModel {
  provider: string;
  id: string;
  api: string;
  cost?: unknown;
  compat?: unknown;
  thinkingLevelMap?: unknown;
  maxTokens?: unknown;
}

const SLUG = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?$/;

function plain(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (JSON.parse(JSON.stringify(value)) as Record<string, unknown>)
    : null;
}

/** The routing entry a pin carries, and LING_MODEL_ROUTING gives the children. */
export function routingFor(spec: PinSpec): ModelRoutingEntry {
  if (!SLUG.test(spec.slug) || spec.slug === spec.model) {
    throw new Error(`${spec.model}'s routing needs OpenRouter's provider slug, not ${JSON.stringify(spec.slug)}`);
  }
  return { order: [spec.slug], allow_fallbacks: false };
}

/** A pin from a catalogue entry: the record a child reports for it, routing applied. */
export function pinFrom(model: CatalogueModel, spec: PinSpec): BatchModel {
  if (model.provider !== ROUTING_PROVIDER || model.id !== spec.model) {
    throw new Error(`the catalogue gave ${model.provider}/${model.id} for ${ROUTING_PROVIDER}/${spec.model}`);
  }
  // Only the chat-completions API reads the routing; on any other the child would carry none.
  if (model.api !== "openai-completions") {
    throw new Error(`${spec.model} is served over ${model.api}, which carries no routing; it cannot be pinned`);
  }
  const routing = routingFor(spec);
  const prices = Object.fromEntries(
    Object.entries(plain(model.cost) ?? {}).filter((entry): entry is [string, number] => typeof entry[1] === "number"),
  );
  const level = (plain(model.thinkingLevelMap) ?? {})[spec.thinking];
  const catalogueMax = typeof model.maxTokens === "number" && model.maxTokens > 0 ? model.maxTokens : null;
  const maxTokens =
    spec.maxTokens === undefined ? catalogueMax : catalogueMax === null ? spec.maxTokens : Math.min(catalogueMax, spec.maxTokens);
  return {
    provider: ROUTING_PROVIDER,
    model: spec.model,
    thinking: spec.thinking,
    routing,
    servedProviderName: spec.servedProviderName,
    prices,
    compat: { ...(plain(model.compat) ?? {}), openRouterRouting: routing },
    thinkingLevel: typeof level === "string" ? level : null,
    maxTokens,
  };
}

/** LING_MODEL_MAX_TOKENS for a batch: each pin's output ceiling, given to every child with the routing. */
export function modelMaxTokensFor(models: { a: BatchModel; b: BatchModel }): Record<string, number> {
  const limits: Record<string, number> = {};
  for (const pin of [models.a, models.b]) if (typeof pin.maxTokens === "number") limits[pin.model] = pin.maxTokens;
  return limits;
}

/**
 * The output ceiling of the endpoints a routing slug allows, from OpenRouter's public endpoint list (no
 * key, no cost): the smallest max_completion_tokens among the endpoints whose tag is the slug or a variant
 * of it (`z-ai/fp8` for `z-ai`). Undefined when the list names none, so the catalogue's value stands.
 */
export async function endpointMaxTokens(model: string, slug: string, fetchImpl: typeof fetch = fetch): Promise<number | undefined> {
  const response = await fetchImpl(`https://openrouter.ai/api/v1/models/${model}/endpoints`);
  if (!response.ok) throw new Error(`OpenRouter's endpoint list for ${model} answered ${response.status}`);
  const body = (await response.json()) as { data?: { endpoints?: { tag?: string; max_completion_tokens?: number | null }[] } };
  const limits = (body.data?.endpoints ?? [])
    .filter((endpoint) => endpoint.tag === slug || endpoint.tag?.startsWith(`${slug}/`) === true)
    .map((endpoint) => endpoint.max_completion_tokens)
    .filter((limit): limit is number => typeof limit === "number" && limit > 0);
  if ((body.data?.endpoints ?? []).every((endpoint) => endpoint.tag !== slug && endpoint.tag?.startsWith(`${slug}/`) !== true)) {
    throw new Error(`OpenRouter lists no ${slug} endpoint for ${model}; the routing would find none`);
  }
  return limits.length > 0 ? Math.min(...limits) : undefined;
}

/** LING_MODEL_ROUTING for a batch: every child of a run is given this same value. */
export function modelRoutingFor(models: { a: BatchModel; b: BatchModel }): ModelRouting {
  return { [models.a.model]: models.a.routing, [models.b.model]: models.b.routing };
}

/**
 * Pins read from ling's installed Pi catalogue, with no models file, credential or cached catalogue
 * of the user's, as a paid run's child with its empty agent directory sees it.
 */
export async function resolvePins(
  lingDir: string,
  specs: { a: PinSpec; b: PinSpec } = PILOT_PIN_SPECS,
): Promise<{ a: BatchModel; b: BatchModel }> {
  const entry = pathToFileURL(path.join(lingDir, "node_modules/@earendil-works/pi-coding-agent/dist/index.js")).href;
  const { ModelRuntime } = (await import(entry)) as {
    ModelRuntime: { create(options: object): Promise<{ getModel(provider: string, id: string): CatalogueModel | undefined }> };
  };
  const empty = mkdtempSync(path.join(os.tmpdir(), "ling-pins-agent-"));
  const runtime = await ModelRuntime.create({
    authPath: path.join(empty, "auth.json"),
    modelsPath: null,
    modelsStorePath: path.join(empty, "models-store.json"),
    allowModelNetwork: false,
  });
  const pin = (spec: PinSpec): BatchModel => {
    const model = runtime.getModel(ROUTING_PROVIDER, spec.model);
    if (model === undefined) throw new Error(`Pi's catalogue has no ${ROUTING_PROVIDER}/${spec.model}`);
    return pinFrom(model, spec);
  };
  return { a: pin(specs.a), b: pin(specs.b) };
}

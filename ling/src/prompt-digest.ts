/**
 * The per-run prompt digest (pilot plan §2.1, §2.4; oversight wire §12.6):
 * what a task's model was shown, as one sha256, so a harness can tell a run
 * that was shown its arm's instrument from one that was shown anything else.
 *
 * Pure, with no SDK import, so a check, and the overlord's experiment e2e at
 * run time, can compute it from what a trace recorded.
 *
 * It covers two things, both as the task's first model call has them after
 * every extension's context hooks (which, while ling uses neither Pi's
 * hidden-declaration nor its forced-prompt projection, is what the provider
 * is sent):
 *
 * - the system prompt: ling's prompt and Pi's own sections after it, such as
 *   `<cwd>` (`before_agent_start`'s prompt, as before);
 * - the tool declarations: every tool the request declares, each its name,
 *   its description and its parameter schema (and Pi's `constrainedSampling`,
 *   where a tool sets it), read from the request's transcript, not from a
 *   template of what ling meant to register (`declaredTools` in the harness).
 *
 * The canonical form, which is what is hashed, as UTF-8:
 *
 * ```
 * JSON.stringify({ systemPrompt, tools: [{ name, description, parameters[, constrainedSampling] }, ...] })
 * ```
 *
 * - No whitespace; the keys in exactly that order.
 * - `tools` in the order the request declares them, not sorted. The model is
 *   sent an ordered list, and the order is part of what it reads. The order
 *   comes from ling's registration code, the same in every run of an arm, so
 *   it costs no spurious difference, and a reorder is a change to what A was
 *   shown that the digest should catch.
 * - `parameters` as the JSON value the request carries (a JSON round trip, so
 *   no typebox symbol keys and no undefined field), its keys in the order the
 *   request has them, for the same reason.
 * - In the prompt and in every string of `tools`, each occurrence of the
 *   task's workspace path, as written and with `\` turned to `/` (the form
 *   Pi's `<cwd>` gives it), is replaced by `<workspace>`. Every run of one arm,
 *   each in a workspace of its own, then has the same digest, and a run shown
 *   anything else has another.
 */
import { createHash } from "node:crypto";

/** One tool as a provider request declares it to the model. */
export interface ToolDeclaration {
  name: string;
  description: string;
  /** The parameter schema, as plain JSON. */
  parameters: unknown;
  /** Pi's strict-sampling setting, sent beside the schema; absent when a tool does not set it. */
  constrainedSampling?: unknown;
}

/** What the workspace path reads as in a prompt digest. */
export const WORKSPACE_PLACEHOLDER = "<workspace>";

function neutralise(text: string, workspaceDir: string): string {
  let neutral = text;
  for (const form of new Set([workspaceDir, workspaceDir.replaceAll("\\", "/")])) {
    if (form !== "") neutral = neutral.replaceAll(form, WORKSPACE_PLACEHOLDER);
  }
  return neutral;
}

/**
 * The canonical form of a prompt and its tool declarations (above), the
 * string `promptDigest` hashes.
 */
export function canonicalPromptForm(
  systemPrompt: string,
  tools: readonly ToolDeclaration[],
  workspaceDir: string,
): string {
  const declared = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: JSON.parse(JSON.stringify(tool.parameters ?? null)) as unknown,
    ...(tool.constrainedSampling === undefined ? {} : { constrainedSampling: tool.constrainedSampling }),
  }));
  // The replacer sees every string value, the prompt's included; no key.
  return JSON.stringify({ systemPrompt, tools: declared }, (_key, value: unknown) =>
    typeof value === "string" ? neutralise(value, workspaceDir) : value,
  );
}

/** The sha256, hex, of `canonicalPromptForm`: a task's `promptDigest`. */
export function promptDigest(
  systemPrompt: string,
  tools: readonly ToolDeclaration[],
  workspaceDir: string,
): string {
  return createHash("sha256").update(canonicalPromptForm(systemPrompt, tools, workspaceDir), "utf8").digest("hex");
}

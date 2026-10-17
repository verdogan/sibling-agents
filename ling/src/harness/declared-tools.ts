/**
 * The tools a provider request declares to the model, read from the request's
 * transcript as Pi 1.0.3 builds it.
 *
 * Pi does not send the tool list beside the messages. It is carried by system
 * messages in the transcript: the one at its head declares the first tools
 * (`toolsAdded`), and a later one adds or removes some wherever the set
 * changes (`toolsAdded`, `toolsRemoved`). What a provider is sent is that
 * list replayed in order, which is what pi-ai's `getCurrentTools` does and
 * this does again, each tool cut to what is declared, as pi-ai's
 * `toToolDeclaration` cuts it: its name, description and parameter schema as
 * JSON, and `constrainedSampling` where set. Kept free of any SDK import, so
 * the runner can read the request its `context_with_system` hook is handed.
 */
import type { ToolDeclaration } from "../prompt-digest.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function declaration(tool: Record<string, unknown>): ToolDeclaration {
  return {
    name: String(tool["name"]),
    description: String(tool["description"] ?? ""),
    parameters: JSON.parse(JSON.stringify(tool["parameters"] ?? null)) as unknown,
    ...(tool["constrainedSampling"] === undefined ? {} : { constrainedSampling: tool["constrainedSampling"] }),
  };
}

/** The tools `messages` leave declared, in the order the transcript declares them. */
export function declaredTools(messages: readonly unknown[]): ToolDeclaration[] {
  const tools = new Map<string, ToolDeclaration>();
  for (const message of messages) {
    if (!isRecord(message) || message["role"] !== "system") continue;
    const removed = Array.isArray(message["toolsRemoved"]) ? message["toolsRemoved"] : [];
    const added = Array.isArray(message["toolsAdded"]) ? message["toolsAdded"] : [];
    for (const tool of removed) if (isRecord(tool)) tools.delete(String(tool["name"]));
    for (const tool of added) if (isRecord(tool)) tools.set(String(tool["name"]), declaration(tool));
  }
  return [...tools.values()];
}

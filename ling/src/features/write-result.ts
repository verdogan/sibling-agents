import { replaceWorkspaceFile } from "../guards.js";
import { defineTool, type HarnessExtension } from "../harness/index.js";
import { WATCH_NEXT_TOOL_NAME } from "../oversight.js";
import { Type } from "typebox";
import type { Feature, FeatureContext } from "./types.js";

/** The runner refuses to read a larger result.json, so the tool refuses to write one. */
export const MAX_RESULT_BYTES = 256 * 1024;

/**
 * Why `data` cannot be written, or undefined when it is a JSON object.
 *
 * What reads result.json reads `data` as an object: the overlord's
 * parseWorkerResult refuses anything else, a watcher's report is one, and a
 * caller reads its fields. A model that sent the object as a JSON string, as
 * deepseek-v4.1-flash did, had its task succeed with none of them. The string
 * is not parsed into an object for it, since a guess at what was meant is not
 * what was sent; the model is told how to send it instead. The schema refuses
 * the same values before execute is reached, so this is the second check of
 * two, the one that holds if a call ever reaches execute unvalidated.
 */
export function resultDataRefusal(data: unknown): string | undefined {
  if (typeof data === "object" && data !== null && !Array.isArray(data)) return undefined;
  if (data === undefined) return "write_result refused: data must be a JSON object, and none was given.";
  const given =
    typeof data === "string"
      ? "a JSON string"
      : Array.isArray(data)
        ? "an array"
        : data === null
          ? "null"
          : `a ${typeof data}`;
  return `write_result refused: data must be a JSON object, not ${given}; pass the fields directly.`;
}

/**
 * A narrow output channel for read-only reviewers. It can replace result.json
 * and cannot modify the disposable artifact snapshot the reviewer is judging.
 */
export const writeResultFeature: Feature = {
  name: "write-result",
  toolNames: ["write_result"],
  // A watcher may write its report more than once: the watcher feature refuses
  // a report that breaks the report contract, and the model has to be told it
  // can fix it and try again rather than that one call is all it gets.
  promptSections: (ctx) =>
    ctx.toolNames.includes(WATCH_NEXT_TOOL_NAME)
      ? [
          `## Writing your report

You do not have a file-writing tool. After the final batch, call write_result to write result.json with your report. If write_result is refused, the refusal names the problem; fix it and call write_result again. The last report written is the one the principal reads.`,
        ]
      : [
          `## Read-only result output

You do not have a general file-writing tool. Call write_result exactly once to
write the required result.json envelope. It can only write that one operational
result file; it cannot change any artifact you are reviewing.`,
        ],
  extension: (ctx: FeatureContext): HarnessExtension => ({
    name: "write-result",
    factory: (pi) => {
      pi.registerTool(
        defineTool({
          name: "write_result",
          label: "Write Result",
          description:
            "Write the task's final JSON envelope to result.json. This tool cannot write any other file.",
          promptSnippet: "write_result: write only the final result.json envelope",
          parameters: Type.Object({
            status: Type.Union([
              Type.Literal("success"),
              Type.Literal("partial"),
              Type.Literal("failure"),
            ]),
            summary: Type.String(),
            // Pi's validation refuses anything else before execute runs, with
            // its own text naming data. The description is what tells the
            // model how to send it.
            data: Type.Object(
              {},
              {
                additionalProperties: true,
                description: "The result's fields, as a JSON object passed directly. Not a JSON string.",
              },
            ),
            steps: Type.Array(Type.String()),
          }),
          execute: async (_toolCallId, params) => {
            const refusal = resultDataRefusal(params.data);
            if (refusal !== undefined) throw new Error(refusal);
            const body = `${JSON.stringify(params, null, 2)}\n`;
            const bytes = Buffer.byteLength(body);
            if (bytes > MAX_RESULT_BYTES) {
              throw new Error(`result.json is ${bytes} bytes; the limit is ${MAX_RESULT_BYTES}.`);
            }
            // Reviewers run read-only precisely because the workspace is not
            // theirs to trust, and a result.json that is already a link would
            // have this tool write through it, into whatever it points at.
            await replaceWorkspaceFile(ctx.workspaceDir, "result.json", body);
            return {
              content: [{ type: "text" as const, text: "Wrote result.json." }],
              details: { bytes },
            };
          },
        }),
      );
    },
  }),
};

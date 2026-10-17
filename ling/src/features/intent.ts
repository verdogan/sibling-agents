import { Type } from "typebox";
import { defineTool, type HarnessExtension } from "../harness/index.js";
import {
  DECLARE_INTENT_TOOL_NAME,
  IntentValidationError,
  MAX_INTENT_ENTRIES,
  MAX_INTENT_ENTRY_CHARS,
  MAX_INTENT_NOTE_CHARS,
  parseIntentDeclaration,
} from "../intent.js";
import type { Feature, FeatureContext } from "./types.js";

const entryList = Type.Array(
  Type.String({ minLength: 1, maxLength: MAX_INTENT_ENTRY_CHARS, pattern: "\\S" }),
  { maxItems: MAX_INTENT_ENTRIES },
);

export const intentFeature: Feature = {
  name: "intent",
  toolNames: [DECLARE_INTENT_TOOL_NAME],
  promptSections: () => [
    `## Declaring what you are about to do

Call declare_intent before you start work, and again whenever the plan changes.
List the programs you expect to run, the hosts you expect to contact, and the
workspace paths you expect to write. A trailing slash on a path covers
everything beneath it.

Your declaration is compared against the tool calls actually recorded for this
task, so it must be made *before* the work it describes. A later declaration
does not cover earlier actions, and declaring nothing leaves your account of
your own work unverifiable.

Declare what you genuinely expect. Guessing wide to be safe is refused:
wildcards are rejected, and a path covering the whole workspace declares
nothing. If you turn out to need something you did not declare, declare it then
and proceed — an honest amendment is recorded as one.`,
  ],
  extension: (ctx: FeatureContext): HarnessExtension => ({
    name: "intent",
    factory: (pi) => {
      pi.registerTool(
        defineTool({
          name: DECLARE_INTENT_TOOL_NAME,
          label: "Declare Intent",
          description:
            "Declare the programs, hosts and paths this task expects to touch, before touching them.",
          promptSnippet: "declare_intent: state the actions you are about to take",
          parameters: Type.Object(
            {
              commands: entryList,
              hosts: entryList,
              writes: entryList,
              note: Type.Optional(
                Type.String({ minLength: 1, maxLength: MAX_INTENT_NOTE_CHARS, pattern: "\\S" }),
              ),
            },
            { additionalProperties: false },
          ),
          // Sequential, so Pi runs every call of the message one at a time, in
          // the order given. Calls are parallel by default: each call's
          // tool_start comes before any of them executes, so a declaration sent
          // in one message with the actions it covers was recorded after their
          // tool_starts, and those actions read as declared too late.
          executionMode: "sequential",
          execute: async (_toolCallId, params) => {
            // Refused rather than recorded-as-given: an unfalsifiable declaration
            // that reached the log would read as a commitment while covering
            // everything, which is worse than no declaration at all.
            let declaration;
            try {
              declaration = parseIntentDeclaration({
                commands: [...params.commands],
                hosts: [...params.hosts],
                writes: [...params.writes],
                ...(params.note === undefined ? {} : { note: params.note }),
              });
            } catch (error) {
              if (error instanceof IntentValidationError) {
                return {
                  content: [{ type: "text" as const, text: `Declaration refused: ${error.message}` }],
                  details: { declared: false },
                  isError: true,
                };
              }
              throw error;
            }
            ctx.onIntentDeclaration(declaration);
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Declared ${declaration.commands.length} program(s), ${declaration.hosts.length} host(s), ${declaration.writes.length} path(s).`,
                },
              ],
              details: { declared: true },
            };
          },
        }),
      );
    },
  }),
};

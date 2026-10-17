/**
 * Reading the seed bytes out of the protocol (reports/experiment-protocol.md,
 * §2 "Seed files (bytes)" and "Files the driver adds (bytes)"), by the reading
 * rules the protocol states for them:
 *
 * - a block is preceded by a label line `` `<set> <path>` `` and followed by
 *   a line `sha256 <hex>`;
 * - its bytes are the lines between the opening fence and a line that is
 *   exactly ```` ``` ````, joined with LF, plus one LF, unless the label ends
 *   in `(no final newline)`;
 * - a section ends at the next heading of level 2 or 3 outside a fence;
 * - CRLF is read as LF first, since a checkout may have CRLF endings.
 *
 * The protocol and the constants are written separately, so comparing them can
 * fail, which is the point.
 */

export interface ProtocolBlock {
  /** The label's set (a scenario or variant); null in the driver-files section. */
  set: string | null;
  path: string;
  content: string;
  /** The `sha256 <hex>` line after the block, if there is one. */
  printedSha256: string | null;
}

const SEED_HEADING = "### Seed files (bytes)";
const DRIVER_HEADING = "### Files the driver adds (bytes)";
const FENCE_OPEN = /^```[A-Za-z0-9_-]*$/;
const LABEL = /^`([^`]+)`(.*)$/;
const SHA_LINE = /^sha256 ([0-9a-f]{64})$/;

function sectionLines(protocol: string, heading: string): string[] | undefined {
  const lines = protocol.replace(/\r\n/g, "\n").split("\n");
  const start = lines.indexOf(heading);
  if (start === -1) return undefined;
  const section: string[] = [];
  let fenced = false;
  for (const line of lines.slice(start + 1)) {
    if (!fenced && /^#{2,3} /.test(line)) break;
    if (line.startsWith("```")) fenced = line === "```" ? !fenced : true;
    section.push(line);
  }
  return section;
}

function blocks(lines: readonly string[], labelled: "set path" | "path"): ProtocolBlock[] {
  const found: ProtocolBlock[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const label = LABEL.exec(lines[index]!);
    if (label === null || !FENCE_OPEN.test(lines[index + 1] ?? "")) continue;
    const body: string[] = [];
    let end = index + 2;
    while (end < lines.length && lines[end] !== "```") body.push(lines[end++]!);
    if (end >= lines.length) throw new Error(`The block labelled ${label[0]} has no closing fence.`);
    const name = label[1]!.trim();
    const space = name.indexOf(" ");
    const [set, path] =
      labelled === "set path" && space > 0
        ? [name.slice(0, space), name.slice(space + 1)]
        : [null, name];
    const finalNewline = !label[2]!.trim().endsWith("(no final newline)");
    const sha = SHA_LINE.exec(lines[end + 1] ?? "");
    found.push({
      set,
      path,
      content: `${body.join("\n")}${finalNewline ? "\n" : ""}`,
      printedSha256: sha?.[1] ?? null,
    });
    index = end;
  }
  return found;
}

/** Every seed block, or undefined when the protocol has no seed section. */
export function extractSeedBlocks(protocol: string): ProtocolBlock[] | undefined {
  const lines = sectionLines(protocol, SEED_HEADING);
  return lines === undefined ? undefined : blocks(lines, "set path");
}

/** The driver-files blocks, or undefined when the protocol has none. */
export function extractDriverBlocks(protocol: string): ProtocolBlock[] | undefined {
  const lines = sectionLines(protocol, DRIVER_HEADING);
  return lines === undefined ? undefined : blocks(lines, "path");
}

/** The protocol's revision, from its header line ("Draft, **revision 3**"). */
export function protocolRevision(protocol: string): number | undefined {
  const match = /\*\*revision (\d+)\*\*/.exec(protocol.slice(0, 2_000));
  return match === null ? undefined : Number(match[1]);
}

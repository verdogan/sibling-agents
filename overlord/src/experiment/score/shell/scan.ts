// Boundary scanners (design spec §4a): where a quoted string, `${…}` or `$(…)`
// ends, as bash scans it. One left-to-right pass each; nothing is expanded.

/** The characters that end an unquoted word. */
export const WORD_END: ReadonlySet<string> = new Set([" ", "\t", "\n", ";", "&", "|", "(", ")", "<", ">"]);

/**
 * The index of the last character of the escape, quoted string or expansion
 * that starts at `at`, as bash scans it: `\x`, `'…'`, `$'…'` (a backslash
 * escapes), `"…"` (a backslash escapes, and expansions nest), a backquote
 * (a backslash escapes), `${…}` and `$(…)`. -1 if it does not close; any
 * other character is its own end.
 */
export function spanEnd(src: string, at: number): number {
  const char = src[at];
  const next = src[at + 1];
  const scan = (from: number, close: string, nested: boolean): number => {
    for (let index = from; index < src.length; index += 1) {
      const current = src[index];
      if (current === "\\") index += 1;
      else if (current === close) return index;
      else if (nested && (current === "`" || (current === "$" && (src[index + 1] === "{" || src[index + 1] === "(")))) {
        index = spanEnd(src, index);
        if (index === -1) return -1;
      }
    }
    return -1;
  };
  if (char === "\\") return Math.min(at + 1, src.length - 1);
  if (char === "'") return src.indexOf("'", at + 1);
  if (char === '"') return scan(at + 1, '"', true);
  if (char === "`") return scan(at + 1, "`", false);
  if (char !== "$") return at;
  if (next === "'") return scan(at + 2, "'", false);
  if (next === "{") return closingBrace(src, at + 2);
  if (next === "(") return closingParen(src, at + 2);
  return at;
}

/** Whether a character starts a quoted string or an expansion `spanEnd` steps over. */
const SPAN_START = new Set(["\\", "'", '"', "`", "$"]);

/**
 * The index of the `}` closing a `${` whose body starts at `start`, or -1. In
 * the body a single quote quotes even when the expansion is double-quoted, as
 * bash (outside POSIX mode) parses `"${X:-'}'}"`.
 */
export function closingBrace(src: string, start: number): number {
  for (let at = start; at < src.length; at += 1) {
    if (src[at] === "}") return at;
    if (SPAN_START.has(src[at]!)) {
      at = spanEnd(src, at);
      if (at === -1) return -1;
    }
  }
  return -1;
}

/**
 * The index of the `)` closing a `(` whose content starts at `start`, or -1:
 * nested parentheses counted, quotes and expansions stepped over, and a `#`
 * that starts a word a comment to the line's end.
 */
export function closingParen(src: string, start: number): number {
  let depth = 0;
  let wordStart = true;
  for (let at = start; at < src.length; at += 1) {
    const char = src[at]!;
    if (char === "#" && wordStart) {
      at = src.indexOf("\n", at);
      if (at === -1) return -1;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") {
      if (depth === 0) return at;
      depth -= 1;
    } else if (SPAN_START.has(char)) {
      at = spanEnd(src, at);
      if (at === -1) return -1;
    }
    wordStart = WORD_END.has(char);
  }
  return -1;
}

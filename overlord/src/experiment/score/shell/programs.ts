// The program grammars (design spec §0b.1 item 9, replacing §4.2's scans): a
// sed script and an awk program are code that can open files, so each is data
// only inside a closed positive grammar. Anything the grammar does not place
// makes the call unresolved (`program_io`). Each reader is one left-to-right
// pass over the text as written (D10); no RegExp is built from command text.
import { parsedBy, type Found } from "./table.js";

/** The program of a sed or awk call outside its grammar, as written; null when it is inside. */
export function programFlag(name: string, values: readonly (string | null)[], written: readonly string[]): string | null {
  return name === "sed" ? sedFlag(values, written) : name === "awk" ? awkFlag(values, written) : null;
}

/** A found option's value: the text attached to its word, or its separate word. */
function optionValue(values: readonly (string | null)[], option: Found): string | null {
  if (option.attached !== null) return option.attached;
  return option.valueIndex === null ? null : values[option.valueIndex] ?? null;
}

/**
 * The sed call's inline script: the `-e`/`--expression` values joined by
 * newlines as sed joins them, else the first operand, read by the table's
 * grammar (`-in` is `-i` with suffix `n`; `-f` is not listed, so a script
 * from a file or stdin is already `unknown_option`). Returns the script as
 * written when it is outside the grammar.
 */
export function sedFlag(values: readonly (string | null)[], written: readonly string[]): string | null {
  const { reason, options, operands } = parsedBy("sed", values);
  if (reason !== null) return null;
  const scripts = options.filter((option) => option.key === "-e" || option.key === "--expression");
  let texts: (string | null)[];
  let shown: string;
  if (scripts.length > 0) {
    texts = scripts.map((option) => optionValue(values, option));
    shown = scripts.map((option) => written[option.attached === null ? option.valueIndex ?? option.wordIndex : option.wordIndex] ?? "").join(" ");
  } else if (operands[0] !== undefined) {
    texts = [values[operands[0]] ?? null];
    shown = written[operands[0]] ?? "";
  } else return null;
  if (texts.some((text) => text === null)) return shown;
  return sedScriptFlags(texts.join("\n")) ? shown : null;
}

const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";
const isBlank = (c: string | undefined) => c === " " || c === "\t";

/**
 * Whether a sed script is outside §0b.1 items 9 and 11's grammar. Inside it are only:
 * - `s` commands with flags from `g`, `p`, `i`, `I` and digits;
 * - `p`, `d`, `=` and `n`, `q` and `Q` with an optional exit code;
 * - `{` … `}` grouping these, and `#` comments (`#n` on the first line too);
 * each with no address, or one or two (`A,B`) addresses, then an optional `!`.
 * An address is a number, `N~M`, `$`, `/regex/` or `\cREGEXc` with flags from
 * `I` and `M`; a second one may also be `+N` or `~N`. Commands are separated by
 * blanks, `;` or newlines, and may end at a `}` or `#`. Everything else (a `w`
 * or `e` flag, `r R w W e F v z`, labels and `b t T`, `a i c`, `y`) is outside.
 */
export function sedScriptFlags(script: string): boolean {
  const n = script.length;
  let at = 0;
  /**
   * A bracket expression on its `[`, as GNU sed 4.9 reads one (checked in Git
   * Bash): the delimiter is a member there (`s/[^/]*$//`), `]` first (or after
   * `^`) is a member, `[:…:]`, `[.….]` and `[=…=]` nest. A backslash or a
   * newline in it, where seds differ, is outside.
   */
  const bracket = (): boolean => {
    let j = at + 1;
    if (script[j] === "^") j += 1;
    if (script[j] === "]") j += 1;
    while (j < n) {
      const c = script[j]!;
      if (c === "\\" || c === "\n") return false;
      if (c === "]") {
        at = j + 1;
        return true;
      }
      const kind = script[j + 1];
      if (c === "[" && (kind === ":" || kind === "." || kind === "=")) {
        let k = j + 2;
        while (k < n && !(script[k] === kind && script[k + 1] === "]")) {
          const inner = script[k];
          if (inner === "\\" || inner === "\n") return false;
          k += 1;
        }
        if (k >= n) return false;
        j = k + 2;
        continue;
      }
      j += 1;
    }
    return false;
  };
  /**
   * A delimited part from `at` (just past its opening delimiter), as GNU sed's
   * match_slash reads it: a backslash takes the next character, the part ends
   * at the delimiter. An unclosed part, or a raw newline in it, is outside.
   */
  const part = (delimiter: string, regex: boolean): boolean => {
    while (at < n) {
      const c = script[at]!;
      if (c === "\\") {
        if (at + 1 >= n) return false;
        at += 2;
      } else if (c === "\n") return false;
      else if (c === delimiter) {
        at += 1;
        return true;
      } else if (regex && c === "[") {
        if (!bracket()) return false;
      } else at += 1;
    }
    return false;
  };
  const digits = (): boolean => {
    if (!isDigit(script[at])) return false;
    while (isDigit(script[at])) at += 1;
    return true;
  };
  /** A regex address after its opening delimiter, then its `I`/`M` flags. */
  const regex = (delimiter: string): boolean => {
    if (!part(delimiter, true)) return false;
    while (script[at] === "I" || script[at] === "M") at += 1;
    return true;
  };
  /** An address (`second`: also `+N`, `~N`); null when none starts here, false when one is malformed. */
  const address = (second: boolean): boolean | null => {
    const c = script[at];
    if (c === "$") {
      at += 1;
      return true;
    }
    if (isDigit(c)) {
      digits();
      if (script[at] !== "~") return true;
      at += 1;
      return digits();
    }
    if (second && (c === "+" || c === "~")) {
      at += 1;
      return digits();
    }
    if (c === "/") {
      at += 1;
      return regex("/");
    }
    if (c === "\\") {
      const delimiter = script[at + 1];
      if (delimiter === undefined || delimiter === "\n" || delimiter === "\\") return false;
      at += 2;
      return regex(delimiter);
    }
    return null;
  };
  const skipBlanks = () => {
    while (isBlank(script[at])) at += 1;
  };
  /** After a command: blanks, then `;`, a newline, the end, or a `}` or `#` left for the loop. */
  const terminated = (): boolean => {
    skipBlanks();
    const c = script[at];
    return c === undefined || c === ";" || c === "\n" || c === "}" || c === "#";
  };
  let depth = 0;
  while (at < n) {
    const c = script[at]!;
    if (isBlank(c) || c === ";" || c === "\n") {
      at += 1;
      continue;
    }
    if (c === "#") {
      while (at < n && script[at] !== "\n") at += 1;
      continue;
    }
    if (c === "}") {
      if (depth === 0) return true;
      depth -= 1;
      at += 1;
      if (!terminated()) return true;
      continue;
    }
    const first = address(false);
    if (first === false) return true;
    if (first === true) {
      skipBlanks();
      if (script[at] === ",") {
        at += 1;
        skipBlanks();
        if (address(true) !== true) return true;
      }
      skipBlanks();
    }
    if (script[at] === "!") {
      at += 1;
      skipBlanks();
    }
    const command = script[at];
    at += 1;
    if (command === "{") {
      depth += 1;
      continue;
    }
    if (command === "q" || command === "Q") {
      skipBlanks();
      while (isDigit(script[at])) at += 1;
      if (!terminated()) return true;
      continue;
    }
    if (command === "p" || command === "d" || command === "=" || command === "n") {
      if (!terminated()) return true;
      continue;
    }
    if (command !== "s") return true;
    const delimiter = script[at];
    if (delimiter === undefined || delimiter === "\\" || delimiter === "\n") return true;
    at += 1;
    if (!part(delimiter, true) || !part(delimiter, false)) return true;
    while (at < n) {
      const flag = script[at]!;
      if (flag !== "g" && flag !== "p" && flag !== "i" && flag !== "I" && !isDigit(flag)) break;
      at += 1;
    }
    if (!terminated()) return true; // a `w` or `e` flag, `m`, and anything unplaced
  }
  return depth !== 0;
}

/** Identifiers an awk program may not hold anywhere (§0b.1 item 9), plus gawk's SYMTAB and FUNCTAB, which reach them indirectly. */
const AWK_BANNED = new Set(["system", "getline", "close", "fflush", "ENVIRON", "ARGV", "ARGC", "PROCINFO", "SYMTAB", "FUNCTAB"]);

const isWordStart = (c: string) => (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || c === "_";
const isWordChar = (c: string) => isWordStart(c) || isDigit(c);

/** A `NAME=VALUE` assignment (`-v`, or an operand awk reads as one): outside when NAME is banned, or when one is required and absent. */
function awkAssignmentFlags(text: string, required: boolean): boolean {
  if (text.length === 0 || !isWordStart(text[0]!)) return required;
  let at = 1;
  while (at < text.length && isWordChar(text[at]!)) at += 1;
  if (text[at] !== "=") return required;
  return AWK_BANNED.has(text.slice(0, at));
}

/**
 * The awk call's program, by §0b.1 item 9: options only `-F` (data) and
 * `-v NAME=VALUE` (data), as the table has them (`-f` and every other option
 * are already `unknown_option`); the first operand is the program; an operand
 * awk reads as an assignment may not set a banned name. Returns the program as
 * written when it is outside the grammar.
 */
export function awkFlag(values: readonly (string | null)[], written: readonly string[]): string | null {
  const { reason, options, operands } = parsedBy("awk", values);
  const program = operands[0];
  if (reason !== null || program === undefined) return null;
  const shown = written[program] ?? "";
  const text = values[program] ?? null;
  if (text === null || awkProgramFlags(text)) return shown;
  for (const option of options) {
    if (option.key !== "-v") continue;
    const value = optionValue(values, option);
    if (value === null || awkAssignmentFlags(value, true)) return shown;
  }
  for (const operand of operands.slice(1)) {
    const value = values[operand] ?? null;
    if (value === null || awkAssignmentFlags(value, false)) return shown;
  }
  return null;
}

/**
 * Whether an awk program is outside §0b.1 item 9's grammar, on the raw text
 * (strings and regexes are not skipped, so a `"` or `/` hides nothing): a
 * banned identifier anywhere, `@`, a `|` that is not part of `||` (`print |`,
 * `| getline`, `|&`), or a `>` after the first `print`/`printf` token (output
 * redirection exists only there; a comparison before it, `NR>1{…}`, is fine).
 */
export function awkProgramFlags(program: string): boolean {
  const n = program.length;
  let printed = false;
  for (let at = 0; at < n; ) {
    const c = program[at]!;
    if (isWordStart(c)) {
      const from = at;
      while (at < n && isWordChar(program[at]!)) at += 1;
      const word = program.slice(from, at);
      if (AWK_BANNED.has(word)) return true;
      if (word === "print" || word === "printf") printed = true;
      continue;
    }
    if (c === "|") {
      if (program[at + 1] !== "|") return true;
      at += 2;
      continue;
    }
    if ((c === ">" && printed) || c === "@") return true;
    at += 1;
  }
  return false;
}

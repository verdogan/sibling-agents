// The bash parser (design spec §3.1, §4.3): POSIX words, quotes, escapes,
// heredocs, redirections, lists, compounds, and the boundaries of `$( )`,
// backquotes and `${ }`. It expands nothing; what it cannot place is a
// parse failure, and past a cap it stops.
import { closingBrace, closingParen, WORD_END } from "./scan.js";
import { literalText } from "./syntax.js";
export { literalText };
import type { CaseArm, Command, List, Part, Pipeline, Quote, Redirection, VarPart, Word } from "./syntax.js";

const BLANK = new Set([" ", "\t"]);

/** D10's caps (§4.3); past one, reading stops with `cap_exceeded`. */
export const CAPS = { text: 65_536, words: 4_096, commands: 1_024, depth: 64, heredocs: 64 } as const;

export class ParseFailure extends Error {
  constructor(readonly code: "parse_error" | "cap_exceeded") {
    super(code);
  }
}

interface Budget {
  words: number;
  commands: number;
  heredocs: number;
}

const fail = (): never => {
  throw new ParseFailure("parse_error");
};

/**
 * The top-level list, one complete command at a time: what parsed before a
 * failure is kept, as bash runs each complete top-level command before the
 * one it cannot parse.
 */
export function parseTop(src: string): { list: List; failure: ParseFailure["code"] | null } {
  const parser = new Parser(src, { words: 0, commands: 0, heredocs: 0 }, 0);
  const list: List = [];
  try {
    parser.top(list);
    return { list, failure: null };
  } catch (error) {
    if (error instanceof ParseFailure) return { list, failure: error.code };
    // Nesting past the stack: the boundary scanners recurse.
    if (error instanceof RangeError) return { list, failure: "cap_exceeded" };
    throw error;
  }
}

export class Parser {
  private pos = 0;
  private readonly pending: Redirection[] = [];

  constructor(
    private readonly src: string,
    private readonly budget: Budget,
    private depth: number,
  ) {
    if (depth > CAPS.depth) throw new ParseFailure("cap_exceeded");
  }

  private nested(src: string): Parser {
    return new Parser(src, this.budget, this.depth + 1);
  }

  private enter(): void {
    this.depth += 1;
    if (this.depth > CAPS.depth) throw new ParseFailure("cap_exceeded");
  }

  /**
   * The top level: each complete line of items is pushed once its heredocs
   * parsed (a body starts at the next newline: `cat <<EOF && ls` waits for it).
   */
  top(into: List): void {
    const held: List = [];
    for (;;) {
      const item = this.item([]);
      if (item === null) break;
      held.push(item);
      if (this.pending.length === 0) into.push(...held.splice(0));
    }
    if (held.length > 0 || this.pending.length > 0) fail();
  }

  /** A whole nested source (a backquote body) as one list. */
  whole(): List {
    const list = this.list([]);
    if (this.pos < this.src.length || this.pending.length > 0) fail();
    return list;
  }

  private peek(offset = 0): string {
    return this.src[this.pos + offset] ?? "";
  }

  private skipBlanks(): void {
    for (;;) {
      const char = this.peek();
      if (BLANK.has(char)) this.pos += 1;
      else if (char === "\\" && this.peek(1) === "\n") this.pos += 2;
      else if (char === "#") {
        while (this.pos < this.src.length && this.peek() !== "\n") this.pos += 1;
      } else return;
    }
  }

  /** Blanks, comments and newlines (reading any heredoc bodies the newlines start). */
  private skipLines(): void {
    for (;;) {
      this.skipBlanks();
      if (this.peek() !== "\n") return;
      this.pos += 1;
      this.readHeredocs();
    }
  }

  private endsWord(offset: number): boolean {
    const next = this.peek(offset);
    return next === "" || WORD_END.has(next);
  }

  /** The reserved word at the cursor (command position), if one is there. */
  private keyword(): string | null {
    const match = /^(?:\[\[|\]\]|[{}!]|[a-z]+)/.exec(this.src.slice(this.pos, this.pos + 9));
    if (match === null || !this.endsWord(match[0].length)) return null;
    return RESERVED.has(match[0]) ? match[0] : null;
  }

  private expect(word: string): void {
    this.skipLines();
    if (this.keyword() !== word) fail();
    this.pos += word.length;
  }

  /** Heredoc bodies start on the line after their operator; one that never ends is a failure. */
  private readHeredocs(): void {
    for (const redirection of this.pending.splice(0)) {
      const heredoc = redirection.heredoc!;
      const lines: string[] = [];
      let closed = false;
      while (this.pos < this.src.length) {
        const end = this.src.indexOf("\n", this.pos);
        const line = this.src.slice(this.pos, end === -1 ? this.src.length : end);
        this.pos = end === -1 ? this.src.length : end + 1;
        const compared = heredoc.strip ? line.replace(/^\t+/, "") : line;
        if (compared === heredoc.delimiter) {
          closed = true;
          break;
        }
        // Unquoted, bash joins a backslash-newline before it looks for the delimiter (r2): not followed.
        if (!heredoc.quoted && /(?:^|[^\\])(?:\\\\)*\\$/.test(line)) fail();
        lines.push(line);
      }
      if (!closed) fail();
      heredoc.body = lines.join("\n");
    }
  }

  private atCloser(closers: readonly string[]): boolean {
    const char = this.peek();
    if (char === ")") return closers.includes(")");
    if (char === ";" && (this.peek(1) === ";" || this.peek(1) === "&")) return closers.includes(";;");
    const word = this.keyword();
    return word !== null && closers.includes(word);
  }

  private list(closers: readonly string[]): List {
    const items: List = [];
    for (;;) {
      const item = this.item(closers);
      if (item === null) return items;
      items.push(item);
    }
  }

  /** One pipeline and its separator; null at a closer or the end. */
  private item(closers: readonly string[]): List[number] | null {
    this.skipLines();
    if (this.pos >= this.src.length || this.atCloser(closers)) return null;
    const char = this.peek();
    if (char === ";" || char === "&" || char === "|" || char === ")") fail();
    const pipeline = this.pipeline();
    this.skipBlanks();
    let separator = "";
    const next = this.peek();
    if (next === "&" && this.peek(1) === "&") separator = "&&";
    else if (next === "|" && this.peek(1) === "|") separator = "||";
    else if (next === "&" && this.peek(1) !== ">") separator = "&";
    else if (next === ";" && this.peek(1) !== ";" && this.peek(1) !== "&") separator = ";";
    else if (next === "\n") separator = "\n";
    this.pos += separator.length;
    if (separator === "&&" || separator === "||") {
      this.skipLines();
      if (this.pos >= this.src.length || this.atCloser(closers)) fail();
    } else if (separator === "\n") this.readHeredocs();
    else if (separator === "" && !(this.pos >= this.src.length || this.atCloser(closers) || next === ";")) fail();
    return { pipeline, separator };
  }

  private pipeline(): Pipeline {
    let negated = false;
    for (;;) {
      this.skipBlanks();
      const word = this.keyword();
      if (word === "!") {
        negated = !negated;
        this.pos += 1;
      } else if (word === "time") {
        this.pos += 4;
        this.skipBlanks();
        if (this.src.startsWith("-p", this.pos) && this.endsWord(2)) this.pos += 2;
      } else break;
    }
    const commands = [this.command()];
    for (;;) {
      this.skipBlanks();
      if (this.peek() !== "|" || this.peek(1) === "|") return { commands, negated };
      this.pos += this.peek(1) === "&" ? 2 : 1;
      this.skipLines();
      commands.push(this.command());
    }
  }

  private command(): Command {
    this.skipBlanks();
    if (this.pos >= this.src.length) fail();
    if (this.peek() === "(" && this.peek(1) === "(") {
      const end = closingParen(this.src, this.pos + 1);
      if (end !== -1 && this.src[end - 1] === ")" && end - 1 > this.pos + 1) {
        const inner = this.nested(this.src.slice(this.pos + 2, end - 1)).operand("double");
        this.pos = end + 1;
        return { kind: "arith", inner, redirections: this.trailing() };
      }
    }
    if (this.peek() === "(") {
      this.pos += 1;
      this.enter();
      const list = this.list([")"]);
      if (this.peek() !== ")") fail();
      this.pos += 1;
      this.depth -= 1;
      return { kind: "subshell", list, redirections: this.trailing() };
    }
    const word = this.keyword();
    if (word !== null) {
      this.enter();
      const compound = this.compound(word);
      this.depth -= 1;
      return compound;
    }
    return this.simple();
  }

  private compound(word: string): Command {
    this.pos += word.length;
    switch (word) {
      case "{": {
        const list = this.list(["}"]);
        this.expect("}");
        return { kind: "group", list, redirections: this.trailing() };
      }
      case "if": {
        const clauses: { cond: List; body: List }[] = [];
        let otherwise: List | null = null;
        for (let keyword = "if"; keyword === "if" || keyword === "elif"; ) {
          const cond = this.list(["then"]);
          this.expect("then");
          clauses.push({ cond, body: this.list(["elif", "else", "fi"]) });
          this.skipLines();
          keyword = this.keyword() ?? fail();
          this.pos += keyword.length;
          if (keyword === "else") {
            otherwise = this.list(["fi"]);
            this.expect("fi");
          } else if (keyword !== "elif" && keyword !== "fi") fail();
        }
        return { kind: "if", clauses, otherwise, redirections: this.trailing() };
      }
      case "case":
        return this.caseCommand();
      case "for":
      case "select":
        return this.forLoop(word);
      case "while":
      case "until": {
        const cond = this.list(["do"]);
        this.expect("do");
        const body = this.list(["done"]);
        this.expect("done");
        const redirections = this.trailing();
        return { kind: "loop", keyword: word, name: null, words: null, cond, arith: null, body, redirections };
      }
      case "function": {
        this.skipBlanks();
        const name = this.word() ?? fail();
        this.skipBlanks();
        if (this.peek() === "(" && this.peek(1) === ")") this.pos += 2;
        this.skipLines();
        return { kind: "funcdef", name: literalText(name), body: this.command(), redirections: [] };
      }
      case "[[":
        return this.conditional();
      default:
        // `then`, `fi`, `done`, `}`… where a command should start.
        return fail();
    }
  }

  private caseCommand(): Command {
    this.skipBlanks();
    const subject = this.word() ?? fail();
    this.skipLines();
    if (this.keyword() !== "in") fail();
    this.pos += 2;
    const arms: CaseArm[] = [];
    for (;;) {
      this.skipLines();
      if (this.keyword() === "esac") {
        this.pos += 4;
        break;
      }
      if (this.pos >= this.src.length) fail();
      if (this.peek() === "(") this.pos += 1;
      const patterns: Word[] = [];
      for (;;) {
        this.skipBlanks();
        patterns.push(this.word() ?? fail());
        this.skipBlanks();
        if (this.peek() === "|") this.pos += 1;
        else if (this.peek() === ")") break;
        else fail();
      }
      this.pos += 1;
      const body = this.list([";;", "esac"]);
      let terminator: CaseArm["terminator"] = ";;";
      if (this.src.startsWith(";;&", this.pos)) terminator = ";;&";
      else if (this.src.startsWith(";&", this.pos)) terminator = ";&";
      if (this.peek() === ";") this.pos += terminator.length;
      arms.push({ patterns, body, terminator });
    }
    return { kind: "case", subject, arms, redirections: this.trailing() };
  }

  private forLoop(keyword: "for" | "select"): Command {
    this.skipBlanks();
    let name: string | null = null;
    let words: Word[] | null = null;
    let arith: Word | null = null;
    if (this.peek() === "(" && this.peek(1) === "(") {
      const end = closingParen(this.src, this.pos + 1);
      if (end === -1 || this.src[end - 1] !== ")") fail();
      arith = this.nested(this.src.slice(this.pos + 2, end - 1)).operand("double");
      this.pos = end + 1;
    } else {
      name = literalText(this.word() ?? fail());
      this.skipLines();
      if (this.keyword() === "in") {
        this.pos += 2;
        words = [];
        for (;;) {
          this.skipBlanks();
          const char = this.peek();
          if (char === ";" || char === "\n" || char === "") break;
          words.push(this.word() ?? fail());
        }
      }
    }
    this.skipBlanks();
    if (this.peek() === ";") this.pos += 1;
    this.skipLines();
    let body: List;
    if (this.keyword() === "{") {
      this.pos += 1;
      body = this.list(["}"]);
      this.expect("}");
    } else {
      this.expect("do");
      body = this.list(["done"]);
      this.expect("done");
    }
    const redirections = this.trailing();
    return { kind: "loop", keyword, name, words, cond: null, arith, body, redirections };
  }

  /** `[[ … ]]`: a simple command whose operators are words. */
  private conditional(): Command {
    const words: Word[] = [{ parts: [{ kind: "lit", text: "[[", quote: "none" }] }];
    for (;;) {
      this.skipLines();
      if (this.pos >= this.src.length) fail();
      if (this.keyword() === "]]") {
        this.pos += 2;
        break;
      }
      const operator = /^(?:&&|\|\||[()!<>])/.exec(this.src.slice(this.pos, this.pos + 2));
      if (operator !== null) {
        words.push({ parts: [{ kind: "lit", text: operator[0], quote: "none" }] });
        this.pos += operator[0].length;
      } else words.push(this.word() ?? fail());
    }
    return { kind: "simple", words, redirections: this.trailing() };
  }

  private simple(): Command {
    const words: Word[] = [];
    const redirections: Redirection[] = [];
    this.budget.commands += 1;
    if (this.budget.commands > CAPS.commands) throw new ParseFailure("cap_exceeded");
    for (;;) {
      this.skipBlanks();
      const char = this.peek();
      if (char === "" || char === "\n" || char === ";" || char === "|" || char === ")") break;
      if (char === "&" && this.peek(1) !== ">") break;
      if (char === "(") {
        // `name () body`: a function definition.
        if (words.length === 1 && redirections.length === 0 && /^\(\s*\)/.test(this.src.slice(this.pos))) {
          this.pos = this.src.indexOf(")", this.pos) + 1;
          this.skipLines();
          return { kind: "funcdef", name: literalText(words[0]!), body: this.command(), redirections: [] };
        }
        fail();
      }
      const processSubstitution = (char === "<" || char === ">") && this.peek(1) === "(";
      const redirection = processSubstitution ? undefined : this.redirection();
      if (redirection !== undefined) {
        redirections.push(redirection);
        continue;
      }
      words.push(this.word() ?? fail());
    }
    if (words.length === 0 && redirections.length === 0) fail();
    return { kind: "simple", words, redirections };
  }

  private trailing(): Redirection[] {
    const redirections: Redirection[] = [];
    for (;;) {
      this.skipBlanks();
      const redirection = this.redirection();
      if (redirection === undefined) return redirections;
      redirections.push(redirection);
    }
  }

  /** A redirection at the cursor, with its fd prefix and target; undefined if none is. */
  private redirection(): Redirection | undefined {
    const start = this.pos;
    let cursor = this.pos;
    while (/[0-9]/.test(this.src[cursor] ?? "")) cursor += 1;
    const rest = this.src.slice(cursor, cursor + 3);
    const op = ["&>>", "&>", "<<<", "<<-", "<<", "<>", "<&", ">>", ">|", ">&", "<", ">"].find(
      (candidate) => rest.startsWith(candidate),
    );
    if (op === undefined || (op.startsWith("&") && cursor !== start)) return undefined;
    const fd = this.src.slice(start, cursor);
    this.pos = cursor + op.length;
    this.skipBlanks();
    if (op === "<&" || op === ">&") {
      const dup = /^(?:[0-9]+|-)/.exec(this.src.slice(this.pos, this.pos + 12));
      if (dup !== null && this.endsWord(dup[0].length)) {
        this.pos += dup[0].length;
        return { op, fd, target: null, heredoc: null };
      }
    }
    const target = this.word() ?? fail();
    if (op === "<<" || op === "<<-") {
      this.budget.heredocs += 1;
      if (this.budget.heredocs > CAPS.heredocs) throw new ParseFailure("cap_exceeded");
      // The delimiter's quotes and escapes are removed (`<<\EOF` ends at `EOF`); any quote makes the body literal.
      // An expansion in it (`<<$X`) is literal text that quotes nothing, so the body expands (r2): not read.
      if (target.parts.some((part) => part.kind !== "lit")) fail();
      const delimiter = literalText(target);
      const quoted = target.parts.some((part) => part.kind !== "lit" || part.quote !== "none");
      const heredoc = { delimiter, strip: op === "<<-", body: "", quoted };
      const redirection: Redirection = { op, fd, target: null, heredoc };
      this.pending.push(redirection);
      return redirection;
    }
    return { op, fd, target, heredoc: null };
  }

  /** One word, quotes removed into parts; undefined at a boundary. */
  private word(): Word | undefined {
    const parts: Part[] = [];
    let literal = "";
    let started = false;
    const flush = () => {
      if (literal !== "") parts.push({ kind: "lit", text: literal, quote: "none" });
      literal = "";
    };
    while (this.pos < this.src.length) {
      const char = this.peek();
      if ((char === "<" || char === ">") && this.peek(1) === "(") {
        flush();
        started = true;
        this.pos += 2;
        this.enter();
        const list = this.list([")"]);
        if (this.peek() !== ")") fail();
        this.pos += 1;
        this.depth -= 1;
        parts.push({ kind: "sub", list, quote: "none", form: "process" });
        continue;
      }
      if (char === "(" && parts.length === 0 && ARRAY_ASSIGNMENT.test(literal)) {
        flush();
        this.pos += 1;
        this.enter();
        const words: Word[] = [];
        for (;;) {
          this.skipLines();
          if (this.peek() === ")") break;
          if (this.pos >= this.src.length) fail();
          words.push(this.word() ?? fail());
        }
        this.pos += 1;
        this.depth -= 1;
        parts.push({ kind: "array", words });
        continue;
      }
      if (WORD_END.has(char)) break;
      started = true;
      if (char === "\\") {
        const next = this.peek(1);
        // Outside quotes a backslash escapes any character: `\X` is a quoted X (`.\.` is `..`).
        flush();
        if (next !== "\n") parts.push({ kind: "lit", text: next === "" ? "\\" : next, quote: "single" });
        this.pos += next === "" ? 1 : 2;
        continue;
      }
      if (char === "'") {
        flush();
        const end = this.src.indexOf("'", this.pos + 1);
        if (end === -1) fail();
        parts.push({ kind: "lit", text: this.src.slice(this.pos + 1, end), quote: "single" });
        this.pos = end + 1;
        continue;
      }
      if (char === '"') {
        flush();
        this.pos += 1;
        this.doubleQuoted(parts);
        continue;
      }
      if (char === "$" || char === "`") {
        flush();
        this.dollar(parts, "none");
        continue;
      }
      literal += char;
      this.pos += 1;
    }
    flush();
    if (!started) return undefined;
    this.budget.words += 1;
    if (this.budget.words > CAPS.words) throw new ParseFailure("cap_exceeded");
    if (parts.length === 0) parts.push({ kind: "lit", text: "", quote: "double" });
    return { parts };
  }

  private doubleQuoted(parts: Part[]): void {
    const before = parts.length;
    let literal = "";
    const flush = () => {
      if (literal !== "") parts.push({ kind: "lit", text: literal, quote: "double" });
      literal = "";
    };
    let closed = false;
    while (this.pos < this.src.length) {
      const char = this.peek();
      if (char === '"') {
        this.pos += 1;
        closed = true;
        break;
      }
      if (char === "\\") {
        const next = this.peek(1);
        // In double quotes only `\$`, a backslash before a backquote, `\"`, `\\` and backslash-newline escape.
        if (next === "\n") this.pos += 2;
        else if (next === "$" || next === "`" || next === '"' || next === "\\") {
          literal += next;
          this.pos += 2;
        } else {
          literal += "\\";
          this.pos += 1;
        }
        continue;
      }
      if (char === "$" || char === "`") {
        flush();
        this.dollar(parts, "double");
        continue;
      }
      literal += char;
      this.pos += 1;
    }
    if (!closed) fail();
    flush();
    // `""` is a quoted empty string: a field that holds it survives (`$E""` is one empty field).
    if (parts.length === before) parts.push({ kind: "lit", text: "", quote: "double" });
  }

  /** `$NAME`, `${…}`, `$( … )`, `$(( … ))`, `$[ … ]`, `$'…'`, `$"…"` or a backquoted command. */
  private dollar(parts: Part[], quote: Quote): void {
    if (this.peek() === "`") {
      let end = this.pos + 1;
      while (end < this.src.length && this.src[end] !== "`") end += this.src[end] === "\\" ? 2 : 1;
      if (end >= this.src.length) fail();
      const inner = this.src.slice(this.pos + 1, end).replace(/\\`/g, "`");
      this.pos = end + 1;
      parts.push({ kind: "sub", list: this.nested(inner).whole(), quote, form: "command" });
      return;
    }
    const start = this.pos;
    const next = this.peek(1);
    if (quote === "none" && next === "'") {
      let end = this.pos + 2;
      while (end < this.src.length && this.src[end] !== "'") end += this.src[end] === "\\" ? 2 : 1;
      if (end >= this.src.length) fail();
      this.pos = end + 1;
      parts.push({ kind: "opaque", form: "dollar_quote", text: this.src.slice(start, this.pos), inner: [], quote });
      return;
    }
    if (quote === "none" && next === '"') {
      this.pos += 2;
      const inner: Part[] = [];
      this.doubleQuoted(inner);
      parts.push({ kind: "opaque", form: "dollar_quote", text: this.src.slice(start, this.pos), inner, quote });
      return;
    }
    if (next === "(" && this.peek(2) === "(") {
      const end = closingParen(this.src, this.pos + 2);
      if (end === -1) fail();
      if (this.src[end - 1] === ")" && end - 1 > this.pos + 2) {
        const inner = this.nested(this.src.slice(this.pos + 3, end - 1)).operand("double");
        this.pos = end + 1;
        parts.push({ kind: "arith", inner, text: this.src.slice(start, this.pos), quote });
        return;
      }
    }
    if (next === "(") {
      this.pos += 2;
      this.enter();
      const list = this.list([")"]);
      if (this.peek() !== ")") fail();
      this.pos += 1;
      this.depth -= 1;
      parts.push({ kind: "sub", list, quote, form: "command" });
      return;
    }
    if (next === "[") {
      const end = this.src.indexOf("]", this.pos + 2);
      if (end === -1) fail();
      const inner = this.nested(this.src.slice(this.pos + 2, end)).operand("double");
      this.pos = end + 1;
      parts.push({ kind: "arith", inner, text: this.src.slice(start, this.pos), quote });
      return;
    }
    if (next === "{") {
      const end = closingBrace(this.src, this.pos + 2);
      if (end === -1) fail();
      parts.push(this.braced(this.src.slice(this.pos + 2, end), quote));
      this.pos = end + 1;
      return;
    }
    const name = /^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/.exec(this.src.slice(this.pos + 1, this.pos + 257))?.[0];
    if (name === undefined) {
      parts.push({ kind: "lit", text: "$", quote });
      this.pos += 1;
      return;
    }
    parts.push({ kind: "var", name, op: null, inner: null, assigns: false, text: `$${name}`, quote });
    this.pos += 1 + name.length;
  }

  /** `${…}`: its boundary, its parameter, and whether anything follows the name. */
  private braced(body: string, quote: Quote): VarPart {
    const text = `\${${body}}`;
    let lead = "";
    let rest = body;
    if (body.length > 1 && (body[0] === "#" || body[0] === "!")) {
      lead = body[0]!;
      rest = body.slice(1);
    }
    const name = PARAMETER.exec(rest)?.[0] ?? "";
    rest = rest.slice(name.length);
    const op = lead === "" && rest === "" && name !== "" ? null : lead + rest;
    const assigns = lead === "" && name !== "" && /^:?=/.test(rest);
    const inner = rest === "" ? null : this.nested(rest).operand(quote);
    return { kind: "var", name, op, inner, assigns, text, quote };
  }

  /**
   * All of the source as one operand: blanks and operators are its text,
   * quotes and expansions work as in a word. In a double-quoted context a
   * single quote is a character. Lenient: the boundary was already found.
   */
  operand(quote: Quote): Word {
    const parts: Part[] = [];
    let literal = "";
    const flush = () => {
      if (literal !== "") parts.push({ kind: "lit", text: literal, quote });
      literal = "";
    };
    while (this.pos < this.src.length) {
      const char = this.peek();
      if (char === "\\") {
        const next = this.peek(1);
        if (next === "\n") this.pos += 2;
        else if (quote === "none" && next !== "") {
          flush();
          parts.push({ kind: "lit", text: next, quote: "single" });
          this.pos += 2;
        } else if (next !== "" && "\"$`}\\".includes(next)) {
          literal += next;
          this.pos += 2;
        } else {
          literal += "\\";
          this.pos += 1;
        }
        continue;
      }
      if (char === "'" && quote === "none") {
        flush();
        const end = this.src.indexOf("'", this.pos + 1);
        const text = this.src.slice(this.pos + 1, end === -1 ? this.src.length : end);
        parts.push({ kind: "lit", text, quote: "single" });
        this.pos = end === -1 ? this.src.length : end + 1;
        continue;
      }
      if (char === '"') {
        flush();
        this.pos += 1;
        // Inside a double-quoted expansion a nested pair only removes its quotes.
        if (quote === "none") this.doubleQuoted(parts);
        continue;
      }
      if (char === "$" || char === "`") {
        flush();
        this.dollar(parts, quote);
        continue;
      }
      literal += char;
      this.pos += 1;
    }
    flush();
    return { parts };
  }
}

const ARRAY_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=$/;

export const PARAMETER = /^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?$!-])/;

const RESERVED = new Set([
  "if", "then", "elif", "else", "fi", "case", "esac", "for", "select", "while", "until",
  "do", "done", "function", "in", "time", "{", "}", "!", "[[", "]]",
]);

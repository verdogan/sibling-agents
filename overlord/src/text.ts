import { createHash } from "node:crypto";

/**
 * Text rules shared by every store that hashes worker-derived strings or puts them
 * in a prompt.
 *
 * This lives outside `pool/` and `objective/` because both need the same two
 * guarantees and a security rule with two implementations eventually has two
 * behaviours. The pool proved the rules; the objective record inherits them rather
 * than restating them.
 */

/**
 * C0 and C1 controls plus DEL, excluding the whitespace ones that `\s` already
 * handles. Two reasons to care rather than one. These bytes reach a prompt, and an
 * invisible character in a claim or a goal is exactly the shape of a smuggled
 * instruction. And content addresses join their parts with a NUL, so text allowed
 * to contain one could forge another record's identity — see `contentAddress`.
 */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u;
/** The same set, global, for stripping. A `/g` regex reused with `test` is stateful. */
const CONTROL_CHARS_GLOBAL = new RegExp(CONTROL_CHARS.source, "gu");

export function hasControlCharacters(value: string): boolean {
  return CONTROL_CHARS.test(value);
}

export function stripControlCharacters(value: string): string {
  return value.replace(CONTROL_CHARS_GLOBAL, "");
}

/**
 * Reduce text to one line: control characters gone, whitespace runs collapsed,
 * ends trimmed.
 *
 * Internal whitespace is collapsed because two workers writing the same sentence
 * with different wrapping have said one thing, not two, and a store that keeps both
 * presents the same statement twice as if it corroborated itself.
 *
 * Control characters are stripped rather than refused because this text arrives
 * from workers, and losing a whole record to one stray byte is the worse failure.
 * Callers holding an *address* rather than prose should refuse instead — see
 * `hasControlCharacters` — because silently rewriting an address yields something
 * that points elsewhere while looking correct.
 */
export function collapseToSingleLine(value: string): string {
  return stripControlCharacters(value).replace(/\s+/gu, " ").trim();
}

/**
 * Reduce text to a lookup key: collapsed to one line, Unicode-normalized, and
 * case-folded.
 *
 * This is for labels a caller has to name again later — a topic, a facet — never for
 * prose. Without it, whoever queries has to reproduce the exact capitalization some
 * worker chose weeks earlier, and `Antalya` and `antalya` are two different things
 * that will never be found together.
 *
 * NFKC first, so text that merely *renders* the same is the same key: a composed and
 * a decomposed accent, or a full-width character pasted out of a listing page.
 *
 * One honest limit. `toLowerCase` is locale-independent by design, which is right for
 * a stored key and wrong for Turkish: `I` folds to `i` rather than to the dotless
 * form, so a Turkish label written with the wrong I is still two keys. Fixing that
 * properly means picking a locale, and a store that folds keys differently depending
 * on who wrote them is worse than one that occasionally splits them. Diacritics are
 * deliberately kept for the same reason — folding them would merge distinct words.
 */
export function normalizeKey(value: string): string {
  return collapseToSingleLine(value.normalize("NFKC")).toLowerCase();
}

/**
 * The separator joining the parts of a content address.
 *
 * A NUL rather than a space because parts are normalized to allow internal spaces,
 * so a space would make `["a b", "c"]` hash identically to `["a", "b c"]` — one
 * record silently wearing another's identity. `collapseToSingleLine` strips NUL, so
 * a caller that normalizes first cannot smuggle a separator in and forge that
 * collision.
 *
 * Written as an escape, deliberately. As a literal byte it is invisible in an
 * editor, git treats the whole file as binary, and it propagates into anything that
 * copies the line — which is exactly what happened before this comment existed.
 */
export const CONTENT_ADDRESS_SEPARATOR = "\u0000";

/**
 * A stable `sha256:`-prefixed address over an ordered list of normalized parts.
 *
 * Order is part of the identity: callers must pass a fixed positional layout, never
 * an object's key order or a set.
 */
export function contentAddress(parts: readonly string[]): string {
  const digest = createHash("sha256")
    .update(parts.join(CONTENT_ADDRESS_SEPARATOR), "utf8")
    .digest("hex");
  return `sha256:${digest}`;
}

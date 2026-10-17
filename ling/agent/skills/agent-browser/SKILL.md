---
name: agent-browser
description: Use the agent_browser tool to navigate websites in a real Chrome browser, inspect rendered pages, interact with flows, and extract structured data. Load this for browser research, web interaction, social-media work, or when a normal HTTP request is blocked or incomplete.
---

# agent-browser

Call the `agent_browser` tool. Pass CLI arguments as an array of strings, one
element per argument. The tool holds the pinned binary, this task's isolated
browser session, and the output limits, so there is nothing to configure and no
reason to shell out. Running agent-browser through bash is refused.

## Core loop

```json
{"args": ["open", "https://example.com"]}
{"args": ["snapshot", "-i", "-c", "--json"]}
{"args": ["click", "@e3", "--json"]}
{"args": ["snapshot", "-i", "-c", "--json"]}
{"args": ["close", "--json"]}
```

Refs such as `@e3` are replaced whenever the page changes. Take a fresh
snapshot after navigating, clicking, submitting, or re-rendering.

For reading without interaction:

```json
{"args": ["read", "https://example.com", "--json"]}
{"args": ["read", "--json"]}
```

The first form fetches agent-readable text directly. The second reads the
rendered DOM in the active browser.

## Prefer one batch

Use `batch` for a known multi-step sequence. It starts one process and returns
one JSON array. Put the step list in `stdin`:

```json
{
  "args": ["batch", "--bail", "--json"],
  "stdin": "[[\"open\",\"https://example.com\"],[\"wait\",\"--load\",\"domcontentloaded\"],[\"snapshot\",\"-i\",\"-c\"],[\"close\"]]"
}
```

Domain restrictions are global flags and go before the subcommand:

```json
{
  "args": ["--allowed-domains", "example.com,*.example.com", "batch", "--bail", "--json"],
  "stdin": "[[\"open\",\"https://example.com\"],[\"snapshot\",\"-i\",\"-c\"],[\"close\"]]"
}
```

Content boundaries, the output cap, and the idle timeout are already applied by
the service. Do not pass `--session`, `--auto-connect`, `--restore`,
`--profile`, or `upgrade`; those are refused.

## Structured extraction

When the page contains a repeated list, use JavaScript to return only the
fields needed. Do not return the whole DOM. Because arguments are passed as an
array, the script needs no shell quoting:

```json
{
  "args": ["eval", "Array.from(document.querySelectorAll('article')).map(n => ({ text: n.innerText, url: n.querySelector('a')?.href ?? null }))", "--json"]
}
```

If the script is long or awkward to inline, write it to a workspace file, read
it back, and pass the contents.

An extractor for recurring monitoring must return a JSON array of:

```json
{
  "sourceId": "stable native id, permalink, or deterministic fallback",
  "url": "absolute canonical URL",
  "author": "display name or handle, or null",
  "text": "visible post text",
  "createdAt": "ISO 8601 timestamp if present, otherwise null"
}
```

Stable identifiers matter. Prefer a native post id or permalink. Never use the
item's position on the page as its id.

## Search and wait

```json
{"args": ["fill", "@e1", "search phrase", "--json"]}
{"args": ["press", "Enter", "--json"]}
{"args": ["wait", "--load", "networkidle", "--json"]}
{"args": ["wait", "--text", "Results", "--json"]}
{"args": ["wait", ".result-list", "--json"]}
```

Prefer a specific selector or expected text. Use a blind millisecond wait only
as a last resort.

## Diagnostics

If a normal command fails unexpectedly:

```json
{"args": ["doctor", "--offline", "--quick", "--json"]}
```

If an element ref fails, re-snapshot. If a modal covers an element, dismiss the
modal and re-snapshot. If the page is empty, inspect a compact full snapshot
before changing strategy.

## Sessions

Every task gets its own session automatically. Still close the browser before
you finish, so the page is not left open while later steps run:

```json
{"args": ["close", "--json"]}
```

The service also closes the session for you when the task ends.

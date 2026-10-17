// The names a child's bash already has in its environment (§0b.1 item 12): a
// plain assignment to one of them reaches every later program the call runs,
// since bash exports what it inherited. They are the provisioner's lists,
// copied because the scorer imports nothing from ling at run time:
// SYSTEM_ENV_KEYS, LING_SETTING_KEYS and the variables a lease sets itself
// (src/ling/local-provisioner.ts). The score check compares this copy with
// that file. On Windows a name matches in any case (`COMSPEC` is `ComSpec`).

const INHERITED = [
  // SYSTEM_ENV_KEYS
  "PATH", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "LC_MESSAGES", "TZ", "TERM",
  "USER", "LOGNAME", "SHELL", "TMPDIR", "XDG_RUNTIME_DIR", "DISPLAY", "WAYLAND_DISPLAY",
  "PATHEXT", "SystemRoot", "SystemDrive", "windir", "ComSpec", "TEMP", "TMP",
  "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "USERNAME", "APPDATA", "LOCALAPPDATA",
  "ProgramData", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "CommonProgramFiles",
  "CommonProgramFiles(x86)", "CommonProgramW6432", "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE", "OS",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "DOCKER_HOST", "CONTAINER_HOST",
  // LING_SETTING_KEYS
  "AGENT_PROVIDER", "AGENT_MODEL", "AGENT_THINKING", "MAX_TURNS", "MAX_WALL_CLOCK_MS", "MAX_COST_USD",
  "MAX_SKILLS_PER_TASK", "MAX_INLINE_SKILLS_PER_TASK", "MAX_INLINE_SKILL_BYTES",
  "MAX_INLINE_SKILLS_TOTAL_BYTES", "TASK_RATE_LIMIT_PER_MINUTE", "TASK_RATE_LIMIT_BURST",
  "SHUTDOWN_GRACE_MS", "SHUTDOWN_CANCEL_WAIT_MS", "SHUTDOWN_HTTP_CLOSE_MS",
  "WORKSPACE_RETENTION_DAYS", "RETENTION_INTERVAL_MS", "QUEUE_RESTORE_MAX_TASKS",
  "QUEUE_RESTORE_MAX_AGE_MS", "RATE_LIMIT_MAX_BUCKETS", "RATE_LIMIT_IDLE_MS",
  "BROWSER_HEADLESS", "BROWSER_TRACE", "AGENT_BROWSER_BIN", "AGENT_BROWSER_MAX_OUTPUT",
  "AGENT_BROWSER_SESSION_PREFIX", "AGENT_BROWSER_IDLE_TIMEOUT_MS",
  "AGENT_BROWSER_REPAIR_COOLDOWN_MS", "HTTP_MAX_BODY_CHARS", "BLOCK_PRIVATE_NETWORK",
  "MAX_TOOL_RESULT_CHARS", "MAX_TOOL_RESULT_CHARS_PER_TURN", "SANDBOX_MODE",
  "CONTAINER_RUNTIME", "SANDBOX_IMAGE", "SANDBOX_NETWORK", "SANDBOX_MEMORY", "SANDBOX_CPUS",
  "SANDBOX_PIDS_LIMIT", "OVERSIGHT_ADVICE_WAIT_MS", "OVERSIGHT_WATCH_IDLE_MS", "LING_MODEL_ROUTING", "LING_MODEL_MAX_TOKENS",
  // Set by the lease itself
  "HOME", "AGENT_TOKEN", "AGENT_TOKENS_JSON", "PI_CODING_AGENT_DIR", "PLAYWRIGHT_BROWSERS_PATH",
  "WORKER_ID", "LING_PARENT_PID", "MAX_CONCURRENCY", "ALLOW_INLINE_SKILLS",
];

const EXACT = new Set(INHERITED);
const FOLDED = new Set(INHERITED.map((name) => name.toUpperCase()));

/** Whether `name` is in a child's environment, so a plain assignment to it is exported (§0b.1 item 12). */
export function inherited(name: string, windows: boolean): boolean {
  return windows ? FOLDED.has(name.toUpperCase()) : EXACT.has(name);
}

/** The copied names, for the score check's comparison with the provisioner. */
export const INHERITED_NAMES: readonly string[] = INHERITED;

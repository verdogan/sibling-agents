import type { HarnessExtension } from "../harness/index.js";
import type {
  CampaignOutgoingMessage,
  CampaignPeerMessageListener,
} from "../campaign.js";
import type { IntentDeclaration } from "../intent.js";
import type { Config } from "../config.js";
import type { Clock, OversightEmitter, OversightMessageListener } from "../oversight.js";
import type { HoldGate, WorkerVariant } from "./oversight.js";

/** The oversight timings this ling runs with, as `/healthz` advertises them. */
export interface OversightTimings {
  adviceWaitMs: number;
  watchIdleMs: number;
  maxHoldMs: number;
}

export interface FeatureContext {
  config: Config;
  taskId: string;
  workspaceDir: string;
  /** Saved browser auth state for this task, when the request named one. */
  storageStatePath?: string;
  /** Report files worth keeping, such as screenshots or traces, to the task outcome. */
  onArtifacts(paths: readonly string[]): void;
  /** Publish the exact passive campaign event through the task's normal event channel. */
  onCampaignMessage(message: CampaignOutgoingMessage): void;
  /**
   * Publish a declaration of intent through the task's normal event channel.
   *
   * Emitted rather than written to the workspace on purpose: the declaration has
   * to leave the machine at the moment it is made, or the task that made it
   * could revise it once it knew what actually happened.
   */
  onIntentDeclaration(declaration: IntentDeclaration): void;
  /** Subscribe to authenticated peer data without exposing transport or credentials. */
  subscribeCampaignMessages(listener: CampaignPeerMessageListener): () => void;
  /** The task's enabled tools, so a feature can choose its prompt variant. */
  toolNames: readonly string[];
  /**
   * The worker prompt variant the task asked for, if any (`POST /tasks`
   * `variant`), which picks the worker feature's texts. Already checked
   * against `toolNames` (`workerVariantRefusal`).
   */
  variant?: WorkerVariant;
  // Oversight plumbing, one set per task (oversight contract §6.10). Required,
  // so a context that forgets one fails to compile rather than running with a
  // gate nothing engages. A check that builds a context for some other feature
  // spreads in `inertOversight`.
  /** Publish an oversight event on the task's stream, as intent declarations are. */
  onOversightEvent: OversightEmitter;
  /** The task's one inbox, for oversight messages. A campaign task never calls it. */
  subscribeOversight(listener: OversightMessageListener): () => void;
  /** Shared by the guards, the worker feature and the runner's wall clock. */
  holdGate: HoldGate;
  /** Aborted by the runner's stop() for every stop reason, ahead of Pi's own signal. */
  stopSignal: AbortSignal;
  oversight: OversightTimings;
  /** Injected so the checks can run a two-minute wait without waiting for it. */
  clock: Clock;
}

/**
 * A self-contained capability, expressed entirely through the harness extension API.
 *
 * A feature owns everything it needs: the tools it registers, the skills that
 * document them, the system-prompt text that introduces them, and the teardown
 * of whatever it started. Nothing about a feature is spelled out in the runner,
 * so adding or removing one is a change to the feature list and nothing else.
 */
export interface Feature {
  name: string;
  /** Tool names this feature registers, in the order they are advertised. */
  toolNames?: readonly string[];
  /**
   * Skill directories this feature owns. Skills are loaded from these paths
   * only, and the model is allowed to read files under them; nothing else
   * outside the workspace becomes readable.
   */
  skillPaths?(ctx: FeatureContext): readonly string[];
  /** System-prompt sections added while this feature is active. */
  promptSections?(ctx: FeatureContext): readonly string[];
  /** The inline extension that registers this feature's tools and hooks. */
  extension(ctx: FeatureContext): HarnessExtension;
  /**
   * An extension placed after the guards and before the budget, for a
   * `context` handler whose output the budget has to price: the provider is
   * sent what that handler returns, so the cost projection must see the same.
   */
  preBudgetExtension?(ctx: FeatureContext): HarnessExtension;
}

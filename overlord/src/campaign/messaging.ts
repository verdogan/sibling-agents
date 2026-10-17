/**
 * Passive messaging: `campaign_send` traffic between simultaneously running
 * slices, carried by the overlord.
 *
 * A message arrives as a `campaign_message` event on its author's stream. It is
 * validated, persisted to `coordination.messages` before any delivery, and then
 * delivered to every running recipient the routing table allows, with
 * `deliveredToTaskIds` written after. A recipient that misses live delivery gets
 * the message later through a fenced seed in its next role task.
 *
 * Moved out of the driver unchanged. The driver still owns the event tap that
 * feeds `handleCampaignMessage`, and the manifest and its persistence, which it
 * lends here through `PassiveMessagingHost`.
 */
import { isTerminalStatus } from "../ling/events.js";
import type { LingEvent, LingPeerMessage, LingPeerMessageResponse } from "../ling/types.js";
import { canDeliverMessage } from "./routing.js";
import type { CampaignManifest } from "./schema.js";

/** The slice of a Ling client that delivery uses. */
export interface PeerMessageClient {
  sendPeerMessage?(
    id: string,
    message: LingPeerMessage,
    workerId?: string,
  ): Promise<LingPeerMessageResponse>;
}

/** What messaging borrows from the driver that runs it. */
export interface PassiveMessagingHost {
  /** The current manifest. Read again after every await: persisting replaces it. */
  manifest(): CampaignManifest;
  persist(mutate: (manifest: CampaignManifest) => void): Promise<void>;
  readonly client: PeerMessageClient;
}

export class PassiveMessaging {
  constructor(private readonly host: PassiveMessagingHost) {}

  async handleCampaignMessage(sourceTaskId: string, event: LingEvent): Promise<void> {
    const source = this.host.manifest().tasks.find((task) => task.id === sourceTaskId);
    if (source === undefined || source.sliceId === null) return;
    // A watcher has no campaign_send, so a message on its stream is not one it
    // was given the means to send.
    const fromRole = source.role;
    if (fromRole === "watcher") return;
    const data =
      typeof event.data === "object" && event.data !== null && !Array.isArray(event.data)
        ? (event.data as Record<string, unknown>)
        : undefined;
    if (data === undefined) return;
    const keys = Object.keys(data);
    if (
      keys.some((key) => !["thread", "content", "mentions", "priority"].includes(key)) ||
      typeof data["thread"] !== "string" ||
      data["thread"].trim() === "" ||
      data["thread"].length > 128 ||
      typeof data["content"] !== "string" ||
      data["content"].trim() === "" ||
      !Array.isArray(data["mentions"]) ||
      data["mentions"].length > 16 ||
      data["mentions"].some(
        (mention) => typeof mention !== "string" || mention.trim() === "" || mention.length > 128,
      ) ||
      !["fyi", "normal", "urgent"].includes(String(data["priority"]))
    ) {
      return;
    }
    const messageId = `${sourceTaskId}:${event.seq}`;
    const existing = this.host.manifest().coordination.messages.find(
      (message) => message.id === messageId,
    );
    if (existing !== undefined) {
      await this.deliverCampaignMessage(existing.id);
      return;
    }
    const content = data["content"];
    if (
      Buffer.byteLength(content, "utf8") > this.host.manifest().coordination.maxMessageBytes
    ) {
      return;
    }
    const mentions = [...new Set(data["mentions"] as string[])];
    const knownSlices = new Set(this.host.manifest().slices.map((slice) => slice.id));
    if (mentions.some((mention) => !knownSlices.has(mention))) return;
    const toSliceIds =
      mentions.length > 0
        ? mentions
        : this.host
            .manifest()
            .slices.map((slice) => slice.id)
            .filter((sliceId) => sliceId !== source.sliceId);
    await this.host.persist((manifest) => {
      if (
        manifest.coordination.messages.some((message) => message.id === messageId) ||
        manifest.coordination.messages.length >= manifest.coordination.maxMessages
      ) {
        return;
      }
      manifest.coordination.messages.push({
        seq: manifest.coordination.messages.length + 1,
        id: messageId,
        thread: data["thread"] as string,
        fromTaskId: sourceTaskId,
        fromRole,
        fromSliceId: source.sliceId,
        toSliceIds,
        priority: data["priority"] as "fyi" | "normal" | "urgent",
        content,
        createdAt: event.at,
        deliveredToTaskIds: [],
      });
    });
    if (
      this.host.manifest().coordination.messages.some((message) => message.id === messageId)
    ) {
      await this.deliverCampaignMessage(messageId);
    }
  }

  async deliverCampaignMessage(messageId: string): Promise<void> {
    const message = this.host.manifest().coordination.messages.find(
      (candidate) => candidate.id === messageId,
    );
    if (message === undefined || this.host.client.sendPeerMessage === undefined) return;
    const delivered = new Set(message.deliveredToTaskIds);
    const recipients = this.host.manifest().tasks.filter(
      (task) =>
        task.id !== message.fromTaskId &&
        task.sliceId !== null &&
        message.toSliceIds.includes(task.sliceId) &&
        !isTerminalStatus(task.status) &&
        !delivered.has(task.id) &&
        canDeliverMessage(message.fromRole, task.role),
    );
    const newlyDelivered: string[] = [];
    for (const recipient of recipients) {
      try {
        const response = await this.host.client.sendPeerMessage(
          recipient.id,
          {
            id: message.id,
            thread: message.thread,
            from: `${message.fromRole}:${message.fromSliceId ?? "-"}`,
            content: message.content,
            priority: message.priority,
            sentAt: message.createdAt,
          },
          recipient.workerId,
        );
        if (response.accepted) newlyDelivered.push(recipient.id);
      } catch {
        // The recipient may have settled between the manifest snapshot and delivery.
        // Its next role task receives the durable message through a fenced seed.
      }
    }
    if (newlyDelivered.length === 0) return;
    await this.host.persist((manifest) => {
      const current = manifest.coordination.messages.find(
        (candidate) => candidate.id === messageId,
      );
      if (current === undefined) return;
      current.deliveredToTaskIds = [
        ...new Set([...current.deliveredToTaskIds, ...newlyDelivered]),
      ];
    });
  }

  async deliverPendingMessagesToTask(taskId: string): Promise<void> {
    const task = this.host.manifest().tasks.find((candidate) => candidate.id === taskId);
    if (
      task?.sliceId === null ||
      task?.sliceId === undefined ||
      isTerminalStatus(task.status) ||
      !this.host.manifest().coordination.passiveMessaging
    ) {
      return;
    }
    const pending = this.host.manifest().coordination.messages.filter(
      (message) =>
        message.toSliceIds.includes(task.sliceId as string) &&
        !message.deliveredToTaskIds.includes(taskId),
    );
    for (const message of pending) await this.deliverCampaignMessage(message.id);
  }
}

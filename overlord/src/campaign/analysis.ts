import type {
  CampaignManifest,
  CampaignRole,
  CampaignSeedChannel,
} from "./schema.js";

export interface CampaignArtifactSeedEdge {
  artifactId: string;
  artifactPath: string;
  channel: CampaignSeedChannel;
  producerTaskId: string | null;
  producerSliceId: string | null;
  consumerTaskId: string;
  consumerRole: CampaignRole;
  consumerSliceId: string | null;
  destination: string;
}

export interface CampaignMessageDeliveryEdge {
  messageId: string;
  sourceTaskId: string;
  sourceSliceId: string | null;
  consumerTaskId: string;
  consumerSliceId: string | null;
  channel: "initial_context" | "live";
}

export interface CampaignDependencyEdge {
  prerequisiteSliceId: string;
  dependentSliceId: string;
}

export interface CampaignCoordinationMetrics {
  tasksWithRecordedSeedProvenance: number;
  tasksWithUnavailableSeedProvenance: number;
  artifactSeedEdges: number;
  tasksSeededWithArtifacts: number;
  distinctSeededArtifacts: number;
  acceptedArtifactSeedEdges: number;
  proposalArtifactSeedEdges: number;
  planningCandidateSeedEdges: number;
  referenceArtifactSeedEdges: number;
  crossTaskArtifactSeedEdges: number;
  crossSliceArtifactSeedEdges: number;
  maxArtifactConsumerTasks: number;
  peerMessages: number;
  initialPeerMessageSeedEdges: number;
  livePeerMessageDeliveryEdges: number;
}

export interface CampaignCoordinationAnalysis {
  metrics: CampaignCoordinationMetrics;
  dependencies: CampaignDependencyEdge[];
  artifactSeeds: CampaignArtifactSeedEdge[];
  messageDeliveries: CampaignMessageDeliveryEdge[];
}

interface ArtifactProducer {
  taskId: string | null;
  sliceId: string | null;
}

function producerIndex(manifest: CampaignManifest): Map<string, ArtifactProducer> {
  const result = new Map<string, ArtifactProducer>();
  for (const [index, ref] of manifest.planning.candidateArtifacts.entries()) {
    result.set(ref.path, {
      taskId: manifest.planning.candidateTaskIds[index] ?? null,
      sliceId: null,
    });
  }
  for (const ref of manifest.planning.artifacts) {
    result.set(ref.path, { taskId: manifest.planning.taskId, sliceId: null });
  }
  for (const slice of manifest.slices) {
    result.set(slice.spec.path, { taskId: manifest.planning.taskId, sliceId: slice.id });
    for (const attempt of slice.attempts) {
      for (const ref of attempt.artifacts) {
        result.set(ref.path, { taskId: attempt.builderId, sliceId: slice.id });
      }
    }
  }
  return result;
}

function maxArtifactConsumerTasks(edges: readonly CampaignArtifactSeedEdge[]): number {
  const consumers = new Map<string, Set<string>>();
  for (const edge of edges) {
    const key = `${edge.artifactId}\u0000${edge.artifactPath}`;
    const tasks = consumers.get(key) ?? new Set<string>();
    tasks.add(edge.consumerTaskId);
    consumers.set(key, tasks);
  }
  return Math.max(0, ...[...consumers.values()].map((tasks) => tasks.size));
}

export function analyzeCampaignCoordination(
  manifest: CampaignManifest,
): CampaignCoordinationAnalysis {
  const producers = producerIndex(manifest);
  const taskById = new Map(manifest.tasks.map((task) => [task.id, task]));
  const artifactSeeds: CampaignArtifactSeedEdge[] = [];
  for (const task of manifest.tasks) {
    for (const seeded of task.seededArtifacts) {
      const producer = producers.get(seeded.artifact.path);
      artifactSeeds.push({
        artifactId: seeded.artifact.artifactId,
        artifactPath: seeded.artifact.path,
        channel: seeded.channel,
        producerTaskId: producer?.taskId ?? null,
        producerSliceId: producer?.sliceId ?? null,
        consumerTaskId: task.id,
        consumerRole: task.role,
        consumerSliceId: task.sliceId,
        destination: seeded.destination,
      });
    }
  }

  const initialMessageEdges: CampaignMessageDeliveryEdge[] = manifest.tasks.flatMap((task) =>
    task.seededMessageIds.map((messageId) => {
      const message = manifest.coordination.messages.find((candidate) => candidate.id === messageId);
      return {
        messageId,
        sourceTaskId: message?.fromTaskId ?? "unknown",
        sourceSliceId: message?.fromSliceId ?? null,
        consumerTaskId: task.id,
        consumerSliceId: task.sliceId,
        channel: "initial_context" as const,
      };
    }),
  );
  const liveMessageEdges: CampaignMessageDeliveryEdge[] =
    manifest.coordination.messages.flatMap((message) =>
      message.deliveredToTaskIds.map((taskId) => ({
        messageId: message.id,
        sourceTaskId: message.fromTaskId,
        sourceSliceId: message.fromSliceId,
        consumerTaskId: taskId,
        consumerSliceId: taskById.get(taskId)?.sliceId ?? null,
        channel: "live" as const,
      })),
    );
  const dependencies = manifest.slices.flatMap((slice) =>
    (slice.dependsOn ?? []).map((prerequisiteSliceId) => ({
      prerequisiteSliceId,
      dependentSliceId: slice.id,
    })),
  );
  const recorded = manifest.tasks.filter(
    (task) => task.seedProvenance === "recorded",
  ).length;
  const metrics: CampaignCoordinationMetrics = {
    tasksWithRecordedSeedProvenance: recorded,
    tasksWithUnavailableSeedProvenance: manifest.tasks.length - recorded,
    artifactSeedEdges: artifactSeeds.length,
    tasksSeededWithArtifacts: new Set(artifactSeeds.map((edge) => edge.consumerTaskId)).size,
    distinctSeededArtifacts: new Set(
      artifactSeeds.map((edge) => `${edge.artifactId}\u0000${edge.artifactPath}`),
    ).size,
    acceptedArtifactSeedEdges: artifactSeeds.filter((edge) => edge.channel === "accepted").length,
    proposalArtifactSeedEdges: artifactSeeds.filter((edge) => edge.channel === "proposal").length,
    planningCandidateSeedEdges: artifactSeeds.filter(
      (edge) => edge.channel === "planning_candidate",
    ).length,
    referenceArtifactSeedEdges: artifactSeeds.filter(
      (edge) => edge.channel === "reference",
    ).length,
    crossTaskArtifactSeedEdges: artifactSeeds.filter(
      (edge) => edge.producerTaskId !== null && edge.producerTaskId !== edge.consumerTaskId,
    ).length,
    crossSliceArtifactSeedEdges: artifactSeeds.filter(
      (edge) =>
        edge.producerSliceId !== null &&
        edge.consumerSliceId !== null &&
        edge.producerSliceId !== edge.consumerSliceId,
    ).length,
    maxArtifactConsumerTasks: maxArtifactConsumerTasks(artifactSeeds),
    peerMessages: manifest.coordination.messages.length,
    initialPeerMessageSeedEdges: initialMessageEdges.length,
    livePeerMessageDeliveryEdges: liveMessageEdges.length,
  };
  return {
    metrics,
    dependencies,
    artifactSeeds,
    messageDeliveries: [...initialMessageEdges, ...liveMessageEdges],
  };
}

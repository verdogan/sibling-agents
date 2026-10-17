/**
 * The slice dependency graph, as both the manifest schema and the replan
 * validator see it.
 */

export interface SliceDependencies {
  id: string;
  /** Omitted means no declared dependencies. */
  dependsOn?: readonly string[];
}

/**
 * The first slice id found on a dependency cycle, or undefined when there is
 * none.
 *
 * Slices are walked depth first in the order given, so the id reported is the
 * same for the same graph. A dependency naming no listed slice is treated as a
 * leaf: callers that care reject unknown ids before asking.
 */
export function dependencyCycle(slices: readonly SliceDependencies[]): string | undefined {
  const dependencies = new Map(slices.map((slice) => [slice.id, slice.dependsOn ?? []] as const));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): string | undefined => {
    if (visited.has(id)) return undefined;
    if (visiting.has(id)) return id;
    visiting.add(id);
    for (const dependency of dependencies.get(id) ?? []) {
      const cycle = visit(dependency);
      if (cycle !== undefined) return cycle;
    }
    visiting.delete(id);
    visited.add(id);
    return undefined;
  };
  for (const id of dependencies.keys()) {
    const cycle = visit(id);
    if (cycle !== undefined) return cycle;
  }
  return undefined;
}

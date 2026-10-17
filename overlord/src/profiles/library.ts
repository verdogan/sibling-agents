import {
  composeNamedProfileFragments,
  type NamedProfileFragment,
} from "./compose.js";
import { parseProfileCatalogue, parseProfileCatalogueJson, parseProfileName } from "./schema.js";
import type {
  ProfileCatalogue,
  ProfileDefinition,
  ProfileFragment,
  ProfileScalarOverrides,
  ResolvedProfile,
} from "./types.js";

export type ProfileLibraryErrorCode = "unknown_fragment" | "unknown_profile";

export class ProfileLibraryError extends Error {
  constructor(
    message: string,
    readonly code: ProfileLibraryErrorCode,
  ) {
    super(message);
    this.name = "ProfileLibraryError";
  }
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function freezeFragment(fragment: ProfileFragment): ProfileFragment {
  return Object.freeze({
    ...fragment,
    ...(fragment.tools === undefined ? {} : { tools: Object.freeze([...fragment.tools]) }),
    ...(fragment.namedSkills === undefined
      ? {}
      : { namedSkills: Object.freeze([...fragment.namedSkills]) }),
    ...(fragment.inlineSkills === undefined
      ? {}
      : {
          inlineSkills: Object.freeze(
            fragment.inlineSkills.map((skill) =>
              Object.freeze({ name: skill.name, content: skill.content }),
            ),
          ),
        }),
    ...(fragment.seedFiles === undefined
      ? {}
      : {
          seedFiles: Object.freeze(
            fragment.seedFiles.map((file) =>
              Object.freeze({ path: file.path, content: file.content }),
            ),
          ),
        }),
  });
}

function freezeDefinition(definition: ProfileDefinition): ProfileDefinition {
  return Object.freeze({
    fragments: Object.freeze([...definition.fragments]),
    ...(definition.overrides === undefined
      ? {}
      : { overrides: Object.freeze({ ...definition.overrides }) }),
  });
}

function freezeCatalogue(catalogue: ProfileCatalogue): ProfileCatalogue {
  const fragments = Object.create(null) as Record<string, ProfileFragment>;
  for (const [name, fragment] of Object.entries(catalogue.fragments)) {
    fragments[name] = freezeFragment(fragment);
  }
  const profiles = Object.create(null) as Record<string, ProfileDefinition>;
  for (const [name, definition] of Object.entries(catalogue.profiles)) {
    profiles[name] = freezeDefinition(definition);
  }
  return Object.freeze({
    version: catalogue.version,
    fragments: Object.freeze(fragments),
    profiles: Object.freeze(profiles),
  });
}

/**
 * Immutable, synchronous profile catalogue. Resolution is cached because both
 * the catalogue and every returned profile are deeply frozen.
 */
export class ProfileLibrary {
  readonly catalogue: ProfileCatalogue;
  private readonly resolved = new Map<string, ResolvedProfile>();

  constructor(catalogue: unknown) {
    this.catalogue = freezeCatalogue(parseProfileCatalogue(catalogue));
  }

  static fromJson(json: string): ProfileLibrary {
    return new ProfileLibrary(parseProfileCatalogueJson(json));
  }

  listFragmentNames(): readonly string[] {
    return Object.freeze(Object.keys(this.catalogue.fragments).sort(compareNames));
  }

  listProfileNames(): readonly string[] {
    return Object.freeze(Object.keys(this.catalogue.profiles).sort(compareNames));
  }

  hasFragment(name: string): boolean {
    const parsed = parseProfileName(name, "fragment name");
    return Object.hasOwn(this.catalogue.fragments, parsed);
  }

  hasProfile(name: string): boolean {
    const parsed = parseProfileName(name, "profile name");
    return Object.hasOwn(this.catalogue.profiles, parsed);
  }

  compose(
    fragmentNames: readonly string[],
    finalOverrides: ProfileScalarOverrides = {},
  ): ResolvedProfile {
    if (!Array.isArray(fragmentNames)) throw new TypeError("Fragment names must be an array.");
    const fragments: NamedProfileFragment[] = fragmentNames.map((unparsedName, index) => {
      const name = parseProfileName(unparsedName, `fragmentNames[${index}]`);
      const fragment = this.catalogue.fragments[name];
      if (fragment === undefined) {
        throw new ProfileLibraryError(
          `Unknown profile fragment ${JSON.stringify(name)}.`,
          "unknown_fragment",
        );
      }
      return { name, fragment };
    });
    return composeNamedProfileFragments(fragments, finalOverrides);
  }

  resolveProfile(unparsedName: string): ResolvedProfile {
    const name = parseProfileName(unparsedName, "profile name");
    const cached = this.resolved.get(name);
    if (cached !== undefined) return cached;
    const definition = this.catalogue.profiles[name];
    if (definition === undefined) {
      throw new ProfileLibraryError(
        `Unknown profile ${JSON.stringify(name)}.`,
        "unknown_profile",
      );
    }
    const resolved = this.compose(definition.fragments, definition.overrides);
    this.resolved.set(name, resolved);
    return resolved;
  }

  /** Alias suitable for call sites that already imply profile resolution. */
  resolve(name: string): ResolvedProfile {
    return this.resolveProfile(name);
  }
}

export function createProfileLibrary(catalogue: unknown): ProfileLibrary {
  return new ProfileLibrary(catalogue);
}

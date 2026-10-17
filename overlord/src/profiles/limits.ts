/**
 * Public resource bounds used by both catalogue validation and composition.
 * All string limits whose name ends in `Bytes` are measured as UTF-8 bytes.
 */
export const PROFILE_LIMITS = Object.freeze({
  catalogueBytes: 4 * 1024 * 1024,
  fragments: 256,
  profiles: 256,
  fragmentReferences: 64,
  nameBytes: 128,
  scalarBytes: 512,
  tools: 128,
  namedSkills: 16,
  inlineSkills: 8,
  inlineSkillBytes: 16 * 1024,
  totalInlineSkillBytes: 64 * 1024,
  // Ling accepts at most 4,000 instruction characters. A UTF-8 byte bound is
  // deliberately no looser, so every resolved profile is valid on the wire.
  instructionsBytes: 4_000,
  seedFiles: 20,
  seedPathBytes: 240,
  seedFileBytes: 128 * 1024,
  totalSeedBytes: 256 * 1024,
} as const);

export const PROFILE_INSTRUCTION_SEPARATOR = "\n\n";

import { config } from "../config.js";
import { createPiHarness } from "../harness/pi.js";

// Allow a catalog refresh so the list reflects what providers currently offer.
const harness = await createPiHarness({ allowModelNetwork: true });
const catalog = await harness.describeCatalog(config.provider);

console.log("providers with credentials configured:");
for (const provider of catalog.configuredProviders) {
  console.log(`  ${provider.id} (${provider.authStatus})`);
}

console.log(`\nmodels you can actually use right now: ${catalog.availableModels.length}`);
for (const model of catalog.availableModels.slice(0, 40)) {
  console.log(`  ${model.provider}/${model.id}`);
}

console.log(`\nall known ${config.provider} models: ${catalog.providerModelIds.length}`);
for (const id of catalog.providerModelIds) {
  const marker = id === config.model ? "  <- AGENT_MODEL" : "";
  console.log(`  ${id}${marker}`);
}

if (!catalog.providerModelIds.includes(config.model)) {
  console.log(
    `\nAGENT_MODEL "${config.model}" is not in the ${config.provider} catalog. Pick one of the ids above and set it in .env.`,
  );
}

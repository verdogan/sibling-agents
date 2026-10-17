import { bootstrapLing } from "../ling/bootstrap.js";

try {
  const runtime = await bootstrapLing();
  console.log(
    `PASS  ling bootstrap -- ${runtime.startedByOverlord ? `started local pid ${runtime.pid ?? "unknown"}` : "reused existing service"}`,
  );
  await runtime.stop();
  if (runtime.startedByOverlord) {
    console.log("PASS  owned ling shutdown");
  }
} catch (error) {
  console.error(`FAIL  ling bootstrap -- ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

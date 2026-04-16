import { defineConfig } from "@trigger.dev/sdk/v3";

export default defineConfig({
  project: "YOUR_TRIGGER_PROJECT_ID",
  // Replace with your Trigger.dev project ID.
  // Found in your Trigger.dev dashboard → Project Settings.

  runtime: "node",
  logLevel: "log",
  maxDuration: 3600,
  retries: {
    enabledInDev: true,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 10000,
      factor: 2,
      randomize: true,
    },
  },
  dirs: ["./trigger"],
});

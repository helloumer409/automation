import { startAutoSync } from "./services/auto-sync.server";

// Start automated sync when server starts (if enabled)
if (process.env.AUTO_SYNC_SCHEDULE) {
  startAutoSync();
}

import { authenticate } from "../shopify.server";
import { performSync } from "../services/sync.server";
import { createSyncStatsRun, completeSyncStatsRun } from "../services/sync-stats.server";

export async function action({ request }) {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  try {
    const result = await performSync(admin, shop);
    return result;
  } catch (error) {
    console.error("❌ Sync failed:", error);
    
    // Save failed sync to database
    if (shop) {
      try {
        const run = await createSyncStatsRun({
          shop,
          totalProducts: 0,
          totalVariants: 0,
        });
        if (run?.id) {
          await completeSyncStatsRun(run.id, {
            synced: 0,
            skipped: 0,
            errors: 1,
            successRate: "0%",
            mapStats: {},
            status: "failed",
            errorMessage: error.message,
          });
        }
      } catch (e) {
        // Swallow stats errors so they don't mask the original sync failure
      }
    }
    
    return {
      success: false,
      error: error.message,
    };
  }
}

// performSync is now exported from app/services/sync.server.js

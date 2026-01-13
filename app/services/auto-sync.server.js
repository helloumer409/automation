import cron from "node-cron";
import { db } from "../db.server";
import { authenticate } from "../shopify.server";

let cronJob = null;

/**
 * Starts automated sync cron job
 * Runs sync every 6 hours by default (configurable via AUTO_SYNC_SCHEDULE env var)
 * 
 * Schedule format: Cron expression (e.g., "0 */6 * * *" = every 6 hours)
 * Default: "0 */6 * * *" (every 6 hours at minute 0)
 * 
 * Examples:
 * - "0 * * * *" = every hour
 * - "0 */2 * * *" = every 2 hours
 * - "0 9 * * *" = daily at 9 AM
 * - "*/30 * * * *" = every 30 minutes (use with caution)
 */
export function startAutoSync() {
  // Stop existing job if running
  if (cronJob) {
    cronJob.stop();
  }

  const schedule = process.env.AUTO_SYNC_SCHEDULE || "0 */6 * * *";
  
  console.log(`⏰ Starting automated sync scheduler: ${schedule}`);
  
  cronJob = cron.schedule(schedule, async () => {
    console.log("🔄 Automated sync triggered by cron job");
    
    try {
      // Get all active shops
      const sessions = await db.session.findMany({
        where: {
          expires: {
            gt: new Date(),
          },
        },
        select: {
          shop: true,
        },
        distinct: ["shop"],
      });

      if (sessions.length === 0) {
        console.log("⚠️ No active sessions found for automated sync");
        return;
      }

      // Import here to avoid circular dependencies
      const { performSync } = await import("../routes/app.sync-apg");

      for (const session of sessions) {
        try {
          console.log(`🔄 Running automated sync for shop: ${session.shop}`);
          
          // Note: Automated sync requires offline access tokens
          // For now, we'll need to handle authentication differently
          // This is a placeholder - you'll need to implement proper offline token handling
          
          // TODO: Implement offline token authentication for automated sync
          console.log(`⚠️ Automated sync for ${session.shop} skipped - requires offline token setup`);
        } catch (error) {
          console.error(`❌ Automated sync failed for ${session.shop}:`, error);
        }
      }
    } catch (error) {
      console.error("❌ Automated sync cron job error:", error);
    }
  }, {
    scheduled: true,
    timezone: "America/New_York", // Adjust to your timezone
  });

  console.log("✅ Automated sync scheduler started");
}

/**
 * Stops the automated sync cron job
 */
export function stopAutoSync() {
  if (cronJob) {
    cronJob.stop();
    cronJob = null;
    console.log("⏹️ Automated sync scheduler stopped");
  }
}

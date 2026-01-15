import cron from "node-cron";
import db from "../db.server";
import shopify from "../shopify.server";

let cronJob = null;

/**
 * Starts automated sync cron job
 * Runs sync every 6 hours by default (configurable via AUTO_SYNC_SCHEDULE env var)
 * 
 * Schedule format: Cron expression (e.g., "0 *\/6 * * *" = every 6 hours)
 * Default: "0 *\/6 * * *" (every 6 hours at minute 0)
 * 
 * Examples:
 * - "0 * * * *" = every hour
 * - "0 *\/2 * * *" = every 2 hours
 * - "0 9 * * *" = daily at 9 AM
 * - "*\/30 * * * *" = every 30 minutes (use with caution)
 */
export function startAutoSync() {
  // Stop existing job if running
  if (cronJob) {
    cronJob.stop();
  }

  // Default to every 6 hours if not specified
  // User can override with AUTO_SYNC_SCHEDULE env var
  // Set AUTO_SYNC_DISABLED=true to disable auto-sync completely
  const schedule = process.env.AUTO_SYNC_SCHEDULE || "0 */6 * * *";
  
  console.log(`⏰ Starting automated sync scheduler: ${schedule}`);
  console.log(`   📅 Sync will run automatically every 6 hours`);
  console.log(`   🔧 To change schedule, set AUTO_SYNC_SCHEDULE env var (e.g., "0 * * * *" for hourly)`);
  console.log(`   ⏹️  To disable, set AUTO_SYNC_DISABLED=true`);
  
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
      const { performSync } = await import("./sync.server");
      const shopifyModule = await import("../shopify.server");
      const shopify = shopifyModule.default;

      for (const session of sessions) {
        try {
          console.log(`🔄 Running automated sync for shop: ${session.shop}`);
          
          // Get full session with access token
          const fullSession = await db.session.findFirst({
            where: {
              shop: session.shop,
              expires: {
                gt: new Date(),
              },
            },
          });

          if (!fullSession || !fullSession.accessToken) {
            console.log(`⚠️ No valid session found for ${session.shop}`);
            continue;
          }

          // Create admin context using session
          // New Shopify app API exposes clients under shopify.api.clients
          const AdminApiClient = shopify.api?.clients?.Admin;
          if (!AdminApiClient) {
            throw new Error("Shopify Admin API client is not available on shopify.api.clients.Admin");
          }
          const admin = new AdminApiClient({ session: fullSession });

          // Run sync
          await performSync(admin, session.shop);
          console.log(`✅ Automated sync completed for ${session.shop}`);
        } catch (error) {
          console.error(`❌ Automated sync failed for ${session.shop}:`, error.message);
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

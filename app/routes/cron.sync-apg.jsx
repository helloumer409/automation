import { performSync } from "./app.sync-apg";
import { db } from "../db.server";
import shopify from "../shopify.server";

/**
 * Automated sync endpoint - can be called by Railway cron or external scheduler
 * 
 * Authentication: Uses SHOPIFY_CRON_SECRET env variable for security
 * 
 * To use with Railway Cron:
 * 1. Set SHOPIFY_CRON_SECRET in Railway environment variables
 * 2. Add cron job in Railway: https://docs.railway.app/develop/cron
 *    Schedule: "0 */6 * * *" (every 6 hours) or "0 * * * *" (every hour)
 *    Command: curl -X POST https://your-app.railway.app/cron/sync-apg?secret=YOUR_SECRET
 * 
 * Or use this endpoint directly with a secret query parameter
 */
export async function loader({ request }) {
  const url = new URL(request.url);
  const secret = url.searchParams.get("secret");
  const expectedSecret = process.env.SHOPIFY_CRON_SECRET;

  // Require secret for security
  if (!expectedSecret || secret !== expectedSecret) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    // Get all shops from database (if multi-shop app)
    // For single-shop apps, you can hardcode the shop domain
    const sessions = await db.session.findMany({
      where: {
        expires: {
          gt: new Date(), // Only active sessions
        },
      },
      select: {
        shop: true,
        accessToken: true,
      },
    });

    if (sessions.length === 0) {
      return new Response(JSON.stringify({ 
        success: false, 
        error: "No active sessions found" 
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const results = [];

    // Run sync for each shop
    for (const session of sessions) {
      try {
        const shop = session.shop;
        
        console.log(`🔄 Starting automated sync for shop: ${shop}`);
        
        // Get full session with all required fields
        const fullSession = await db.session.findFirst({
          where: {
            shop: shop,
            expires: {
              gt: new Date(),
            },
          },
        });

        if (!fullSession || !fullSession.accessToken) {
          results.push({
            shop,
            status: "error",
            error: "No valid session with access token found",
          });
          continue;
        }

        // Create admin context using the session's access token
        const admin = shopify.clients.admin({
          session: fullSession,
        });

        // Actually call performSync to run the sync
        const syncResult = await performSync(admin, shop);
        
        results.push({
          shop,
          status: "success",
          synced: syncResult.synced || 0,
          skipped: syncResult.skipped || 0,
          errors: syncResult.errors?.length || 0,
          successRate: syncResult.successRate || "0%",
          message: syncResult.message || "Sync completed",
        });
        
        console.log(`✅ Automated sync completed for ${shop}: ${syncResult.synced} synced, ${syncResult.skipped} skipped`);
      } catch (error) {
        console.error(`❌ Automated sync failed for ${session.shop}:`, error);
        results.push({
          shop: session.shop,
          status: "error",
          error: error.message || "Unknown error",
        });
      }
    }

    return new Response(JSON.stringify({
      success: true,
      timestamp: new Date().toISOString(),
      results,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("❌ Automated sync failed:", error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message,
    }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

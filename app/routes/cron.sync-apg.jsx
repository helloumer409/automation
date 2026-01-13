import { authenticate } from "../shopify.server";
import { performSync } from "./app.sync-apg";
import { db } from "../db.server";

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
        // Create admin context manually (simplified - may need adjustment based on your auth setup)
        // This is a workaround - in production, you may need to use Shopify's offline token
        const shop = session.shop;
        
        console.log(`🔄 Starting automated sync for shop: ${shop}`);
        
        // Note: This requires offline access token or OAuth token refresh
        // For now, we'll attempt to authenticate using the session
        // You may need to adjust this based on your authentication flow
        
        // For automated sync, we need an admin context
        // This is a placeholder - you'll need to implement proper offline token handling
        // or use Shopify's app bridge with offline tokens
        
        results.push({
          shop,
          status: "skipped",
          message: "Automated sync requires offline token setup - see documentation",
        });
      } catch (error) {
        results.push({
          shop: session.shop,
          status: "error",
          error: error.message,
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

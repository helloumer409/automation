import { authenticate } from "../shopify.server";
import { getLatestSyncStats } from "../services/sync-stats.server";

// Simple JSON endpoint for polling sync progress from the dashboard
export async function loader({ request }) {
  let session, shop;
  
  try {
    const authResult = await authenticate.admin(request);
    session = authResult.session;
    shop = session.shop;

    if (!shop) {
      return new Response(
        JSON.stringify({ success: false, error: "Shop not found in session" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    const stats = await getLatestSyncStats(shop);

    if (!stats) {
      return new Response(
        JSON.stringify({ success: false, error: "No sync stats found", status: "idle" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    const total = stats.totalVariants || 0;
    const processed = (stats.synced || 0) + (stats.skipped || 0);
    const progress = total > 0 ? Number(((processed / total) * 100).toFixed(1)) : 0;

    return new Response(
      JSON.stringify({
        success: true,
        status: stats.status,
        totalVariants: total,
        processed,
        synced: stats.synced || 0,
        skipped: stats.skipped || 0,
        errors: stats.errors || 0,
        progress,
        syncStartedAt: stats.syncStartedAt,
        syncCompletedAt: stats.syncCompletedAt,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (error) {
    // Handle authentication errors gracefully (session might have expired)
    if (error.status === 401 || error.statusCode === 401 || error.message?.includes("401") || error.message?.includes("Unauthorized")) {
      console.warn("⚠️ Session expired during progress check - sync may still be running");
      // Return a response indicating we couldn't authenticate, but don't throw
      return new Response(
        JSON.stringify({
          success: false,
          error: "Session expired - refresh page to re-authenticate",
          requiresReauth: true,
          status: "unknown",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    // Re-throw other errors
    throw error;
  }
}


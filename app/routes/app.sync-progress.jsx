import { authenticate } from "../shopify.server";
import { getLatestSyncStats } from "../services/sync-stats.server";

// Simple JSON endpoint for polling sync progress from the dashboard
export async function loader({ request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  if (!shop) {
    return new Response(
      JSON.stringify({ success: false, error: "Shop not found in session" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const stats = await getLatestSyncStats(shop);

  if (!stats) {
    return new Response(
      JSON.stringify({ success: false, error: "No sync stats found" }),
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
}


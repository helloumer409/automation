import { db } from "../db.server";

/**
 * Saves sync statistics to database
 */
export async function saveSyncStats({
  shop,
  totalProducts,
  totalVariants,
  synced,
  skipped,
  errors,
  successRate,
  mapStats,
  status = "completed",
  errorMessage = null,
}) {
  try {
    const syncStats = await db.syncStats.create({
      data: {
        shop,
        totalProducts,
        totalVariants,
        synced,
        skipped,
        errors,
        successRate: successRate ? parseFloat(successRate.replace("%", "")) : null,
        mapMatched: mapStats?.mapMatched || 0,
        mapUsedJobber: mapStats?.mapUsedJobber || 0,
        mapUsedRetail: mapStats?.mapUsedRetail || 0,
        mapSkipped: mapStats?.mapSkipped || 0,
        status,
        errorMessage,
        syncCompletedAt: new Date(),
      },
    });
    return syncStats;
  } catch (error) {
    console.error("Failed to save sync stats:", error);
    return null;
  }
}

/**
 * Gets the most recent sync stats for a shop
 */
export async function getLatestSyncStats(shop) {
  try {
    const latest = await db.syncStats.findFirst({
      where: { shop },
      orderBy: { createdAt: "desc" },
    });
    return latest;
  } catch (error) {
    console.error("Failed to get sync stats:", error);
    return null;
  }
}

/**
 * Gets sync stats history for a shop
 */
export async function getSyncStatsHistory(shop, limit = 10) {
  try {
    const history = await db.syncStats.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return history;
  } catch (error) {
    console.error("Failed to get sync stats history:", error);
    return [];
  }
}

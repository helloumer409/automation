import db from "../db.server";

/**
 * Creates a new sync stats run with status "running".
 * Used at the start of a sync so progress can be updated while it runs.
 */
export async function createSyncStatsRun({
  shop,
  totalProducts,
  totalVariants,
}) {
  try {
    const syncStats = await db.syncStats.create({
      data: {
        shop,
        totalProducts,
        totalVariants,
        synced: 0,
        skipped: 0,
        errors: 0,
        successRate: null,
        mapMatched: 0,
        mapUsedJobber: 0,
        mapUsedRetail: 0,
        mapSkipped: 0,
        status: "running",
        errorMessage: null,
        syncCompletedAt: null,
      },
    });
    return syncStats;
  } catch (error) {
    console.error("Failed to create sync stats run:", error);
    return null;
  }
}

/**
 * Updates an existing sync stats run while it is in progress.
 */
export async function updateSyncStatsRun(id, {
  synced,
  skipped,
  errors,
  mapStats,
}) {
  try {
    const syncStats = await db.syncStats.update({
      where: { id },
      data: {
        synced,
        skipped,
        errors,
        mapMatched: mapStats?.mapMatched ?? undefined,
        mapUsedJobber: mapStats?.mapUsedJobber ?? undefined,
        mapUsedRetail: mapStats?.mapUsedRetail ?? undefined,
        mapSkipped: mapStats?.mapSkipped ?? undefined,
      },
    });
    return syncStats;
  } catch (error) {
    console.error("Failed to update sync stats run:", error);
    return null;
  }
}

/**
 * Marks a sync stats run as completed or failed with final numbers.
 */
export async function completeSyncStatsRun(id, {
  synced,
  skipped,
  errors,
  successRate,
  mapStats,
  status = "completed",
  errorMessage = null,
}) {
  try {
    const syncStats = await db.syncStats.update({
      where: { id },
      data: {
        synced,
        skipped,
        errors,
        successRate: successRate != null
          ? (typeof successRate === "string"
              ? parseFloat(successRate.replace("%", ""))
              : successRate)
          : null,
        mapMatched: mapStats?.mapMatched ?? undefined,
        mapUsedJobber: mapStats?.mapUsedJobber ?? undefined,
        mapUsedRetail: mapStats?.mapUsedRetail ?? undefined,
        mapSkipped: mapStats?.mapSkipped ?? undefined,
        status,
        errorMessage,
        syncCompletedAt: new Date(),
      },
    });
    return syncStats;
  } catch (error) {
    console.error("Failed to complete sync stats run:", error);
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

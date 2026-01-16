-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_SyncStats" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "syncStartedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "syncCompletedAt" DATETIME,
    "totalProducts" INTEGER NOT NULL DEFAULT 0,
    "totalVariants" INTEGER NOT NULL DEFAULT 0,
    "synced" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "errors" INTEGER NOT NULL DEFAULT 0,
    "successRate" REAL,
    "mapMatched" INTEGER NOT NULL DEFAULT 0,
    "mapUsedJobber" INTEGER NOT NULL DEFAULT 0,
    "mapUsedRetail" INTEGER NOT NULL DEFAULT 0,
    "mapSkipped" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'running',
    "errorMessage" TEXT,
    "csvDownloadedAt" DATETIME,
    "isFullSync" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_SyncStats" ("createdAt", "errorMessage", "errors", "id", "mapMatched", "mapSkipped", "mapUsedJobber", "mapUsedRetail", "shop", "skipped", "status", "successRate", "syncCompletedAt", "syncStartedAt", "synced", "totalProducts", "totalVariants", "updatedAt") SELECT "createdAt", "errorMessage", "errors", "id", "mapMatched", "mapSkipped", "mapUsedJobber", "mapUsedRetail", "shop", "skipped", "status", "successRate", "syncCompletedAt", "syncStartedAt", "synced", "totalProducts", "totalVariants", "updatedAt" FROM "SyncStats";
DROP TABLE "SyncStats";
ALTER TABLE "new_SyncStats" RENAME TO "SyncStats";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

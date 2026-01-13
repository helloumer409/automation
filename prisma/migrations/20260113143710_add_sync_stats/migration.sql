-- CreateTable
CREATE TABLE "SyncStats" (
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

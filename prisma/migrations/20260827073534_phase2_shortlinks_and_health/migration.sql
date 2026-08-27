-- CreateTable
CREATE TABLE "short_links" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "curatorLinkId" TEXT NOT NULL,
    "channel" TEXT,
    "targetUrl" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "short_links_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "deals" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "short_links_curatorLinkId_fkey" FOREIGN KEY ("curatorLinkId") REFERENCES "curator_links" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "click_events" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shortLinkId" TEXT NOT NULL,
    "ts" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "referer" TEXT,
    "uaClass" TEXT NOT NULL DEFAULT 'human',
    "country" TEXT,
    CONSTRAINT "click_events_shortLinkId_fkey" FOREIGN KEY ("shortLinkId") REFERENCES "short_links" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_curator_links" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "dealId" TEXT NOT NULL,
    "variantId" TEXT,
    "rawUrl" TEXT NOT NULL,
    "ulid" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT true,
    "health" TEXT NOT NULL DEFAULT 'UNCHECKED',
    "healthCheckedAt" DATETIME,
    "soldoutStreak" INTEGER NOT NULL DEFAULT 0,
    "healthCheckAfter" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "curator_links_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "deals" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "curator_links_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variants" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_curator_links" ("createdAt", "dealId", "health", "healthCheckedAt", "id", "isDefault", "rawUrl", "ulid", "variantId") SELECT "createdAt", "dealId", "health", "healthCheckedAt", "id", "isDefault", "rawUrl", "ulid", "variantId" FROM "curator_links";
DROP TABLE "curator_links";
ALTER TABLE "new_curator_links" RENAME TO "curator_links";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "short_links_code_key" ON "short_links"("code");

-- CreateIndex
CREATE UNIQUE INDEX "short_links_dealId_curatorLinkId_channel_key" ON "short_links"("dealId", "curatorLinkId", "channel");

-- CreateIndex
CREATE INDEX "click_events_shortLinkId_ts_idx" ON "click_events"("shortLinkId", "ts");

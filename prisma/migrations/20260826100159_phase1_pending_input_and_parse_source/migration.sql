-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_deals" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "productId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "approvalStage" TEXT NOT NULL DEFAULT 'CANDIDATE',
    "telegramChatId" TEXT,
    "telegramMessageId" INTEGER,
    "sourceUrlRaw" TEXT,
    "pendingInput" TEXT,
    "parseSource" TEXT,
    "parseFieldCount" INTEGER NOT NULL DEFAULT 0,
    "salePrice" INTEGER,
    "discountRate" INTEGER,
    "couponCode" TEXT,
    "couponDesc" TEXT,
    "couponExpiresAt" DATETIME,
    "finalPrice" INTEGER,
    "endsAt" DATETIME,
    "hookLine" TEXT,
    "curatorNote" TEXT,
    "aiScore" REAL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "deals_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "deals_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "creators" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_deals" ("aiScore", "approvalStage", "couponCode", "couponDesc", "couponExpiresAt", "createdAt", "creatorId", "curatorNote", "discountRate", "endsAt", "finalPrice", "hookLine", "id", "priority", "productId", "salePrice", "sourceUrlRaw", "status", "telegramChatId", "telegramMessageId", "updatedAt") SELECT "aiScore", "approvalStage", "couponCode", "couponDesc", "couponExpiresAt", "createdAt", "creatorId", "curatorNote", "discountRate", "endsAt", "finalPrice", "hookLine", "id", "priority", "productId", "salePrice", "sourceUrlRaw", "status", "telegramChatId", "telegramMessageId", "updatedAt" FROM "deals";
DROP TABLE "deals";
ALTER TABLE "new_deals" RENAME TO "deals";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

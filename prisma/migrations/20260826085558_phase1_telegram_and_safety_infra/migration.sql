-- CreateTable
CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ts" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "channel" TEXT,
    "approvalRef" TEXT,
    "payloadHash" TEXT,
    "payloadSnapshot" TEXT,
    "responseCode" INTEGER,
    "responseId" TEXT,
    "detail" TEXT
);

-- CreateTable
CREATE TABLE "fetch_log" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ts" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "url" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "responseCode" INTEGER,
    "durationMs" INTEGER,
    "bytes" INTEGER,
    "detail" TEXT
);

-- CreateTable
CREATE TABLE "circuit_state" (
    "host" TEXT NOT NULL PRIMARY KEY,
    "state" TEXT NOT NULL DEFAULT 'HEALTHY',
    "pausedUntil" DATETIME,
    "reason" TEXT,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "policy" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "note" TEXT,
    "updatedAt" DATETIME NOT NULL
);

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
INSERT INTO "new_deals" ("aiScore", "couponCode", "couponDesc", "couponExpiresAt", "createdAt", "creatorId", "curatorNote", "discountRate", "endsAt", "finalPrice", "hookLine", "id", "priority", "productId", "salePrice", "status", "updatedAt") SELECT "aiScore", "couponCode", "couponDesc", "couponExpiresAt", "createdAt", "creatorId", "curatorNote", "discountRate", "endsAt", "finalPrice", "hookLine", "id", "priority", "productId", "salePrice", "status", "updatedAt" FROM "deals";
DROP TABLE "deals";
ALTER TABLE "new_deals" RENAME TO "deals";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "audit_log_ts_idx" ON "audit_log"("ts");

-- CreateIndex
CREATE INDEX "audit_log_approvalRef_idx" ON "audit_log"("approvalRef");

-- CreateIndex
CREATE INDEX "fetch_log_ts_idx" ON "fetch_log"("ts");

-- CreateIndex
CREATE INDEX "fetch_log_host_ts_idx" ON "fetch_log"("host", "ts");

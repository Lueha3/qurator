-- CreateTable
CREATE TABLE "price_snapshots" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "productId" TEXT NOT NULL,
    "capturedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "listPrice" INTEGER,
    "salePrice" INTEGER,
    "couponPrice" INTEGER,
    "source" TEXT NOT NULL,
    "eventTag" TEXT,
    "note" TEXT,
    CONSTRAINT "price_snapshots_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "watch_items" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "productId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "watch_items_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "price_snapshots_productId_capturedAt_idx" ON "price_snapshots"("productId", "capturedAt");

-- CreateIndex
CREATE UNIQUE INDEX "watch_items_productId_key" ON "watch_items"("productId");

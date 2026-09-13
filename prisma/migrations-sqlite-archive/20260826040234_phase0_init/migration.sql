-- CreateTable
CREATE TABLE "creators" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "handle" TEXT NOT NULL,
    "curatorShopUrl" TEXT,
    "toneProfile" TEXT,
    "sizeProfile" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "products" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "creatorId" TEXT NOT NULL,
    "musinsaGoodsNo" TEXT,
    "canonicalUrl" TEXT NOT NULL,
    "brandName" TEXT NOT NULL,
    "brandNameEn" TEXT,
    "productName" TEXT NOT NULL,
    "styleCode" TEXT,
    "categoryPath" TEXT,
    "listPrice" INTEGER NOT NULL,
    "mainImageUrl" TEXT,
    "source" TEXT NOT NULL DEFAULT 'PASTE',
    "capturedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "products_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "creators" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "product_variants" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "productId" TEXT NOT NULL,
    "colorName" TEXT NOT NULL,
    "sizeName" TEXT,
    "stockState" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "stockCheckedAt" DATETIME,
    CONSTRAINT "product_variants_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "deals" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "productId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
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

-- CreateTable
CREATE TABLE "curator_links" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "dealId" TEXT NOT NULL,
    "variantId" TEXT,
    "rawUrl" TEXT NOT NULL,
    "ulid" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT true,
    "health" TEXT NOT NULL DEFAULT 'UNCHECKED',
    "healthCheckedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "curator_links_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "deals" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "curator_links_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variants" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "content_cards" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "dealId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "bodyText" TEXT NOT NULL,
    "charCount" INTEGER NOT NULL,
    "disclosureOk" BOOLEAN NOT NULL,
    "aiGeneratedFields" TEXT,
    "approvedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "content_cards_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "deals" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "posts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "contentCardId" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "publishedAt" DATETIME,
    CONSTRAINT "posts_contentCardId_fkey" FOREIGN KEY ("contentCardId") REFERENCES "content_cards" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "posts_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "deals" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "creators_handle_key" ON "creators"("handle");

-- CreateIndex
CREATE UNIQUE INDEX "products_creatorId_musinsaGoodsNo_key" ON "products"("creatorId", "musinsaGoodsNo");

-- CreateIndex
CREATE UNIQUE INDEX "content_cards_dealId_channel_version_key" ON "content_cards"("dealId", "channel", "version");

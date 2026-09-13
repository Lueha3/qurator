-- CreateEnum
CREATE TYPE "CaptureSource" AS ENUM ('EXTENSION', 'PASTE', 'RADAR', 'SHARE', 'SCREENSHOT');

-- CreateEnum
CREATE TYPE "StockState" AS ENUM ('IN_STOCK', 'LOW', 'SOLDOUT', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "DealStatus" AS ENUM ('DRAFT', 'READY', 'PUBLISHED', 'EXPIRED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "PendingInput" AS ENUM ('CURATOR_LINK', 'HOOK');

-- CreateEnum
CREATE TYPE "ApprovalStage" AS ENUM ('CANDIDATE', 'AWAITING_LINK', 'READY_TO_PUBLISH', 'APPROVED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "LinkHealth" AS ENUM ('OK', 'SOLDOUT', 'COUPON_EXPIRED', 'DEAD', 'UNCHECKED');

-- CreateEnum
CREATE TYPE "Channel" AS ENUM ('KAKAO_OPEN', 'THREADS', 'INSTAGRAM_COMMENT', 'NOTION');

-- CreateEnum
CREATE TYPE "PostMode" AS ENUM ('AUTO_API', 'SEMI_COPIED', 'SEMI_SENT_TO_ME');

-- CreateEnum
CREATE TYPE "PostStatus" AS ENUM ('PENDING', 'SENT', 'CONFIRMED', 'FAILED');

-- CreateEnum
CREATE TYPE "ShortLinkState" AS ENUM ('ACTIVE', 'DEAD');

-- CreateEnum
CREATE TYPE "Actor" AS ENUM ('HUMAN', 'SYSTEM');

-- CreateEnum
CREATE TYPE "FetchTrigger" AS ENUM ('USER_URL', 'HEALTH_CHECK', 'RADAR', 'ROBOTS', 'WATCH');

-- CreateEnum
CREATE TYPE "FetchOutcome" AS ENUM ('OK', 'BLOCKED_POLICY', 'BLOCKED_ROBOTS', 'BLOCKED_BUDGET', 'BLOCKED_CIRCUIT', 'BOT_CHALLENGE', 'HTTP_ERROR', 'TIMEOUT', 'NETWORK_ERROR');

-- CreateEnum
CREATE TYPE "Circuit" AS ENUM ('HEALTHY', 'DEGRADED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "SnapshotSource" AS ENUM ('USER_URL', 'HEALTH_CHECK', 'WATCH', 'MANUAL', 'SCREENSHOT');

-- CreateTable
CREATE TABLE "creators" (
    "id" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "curatorShopUrl" TEXT,
    "toneProfile" TEXT,
    "sizeProfile" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "creators_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" TEXT NOT NULL,
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
    "source" "CaptureSource" NOT NULL DEFAULT 'PASTE',
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_variants" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "colorName" TEXT NOT NULL,
    "sizeName" TEXT,
    "stockState" "StockState" NOT NULL DEFAULT 'UNKNOWN',
    "stockCheckedAt" TIMESTAMP(3),

    CONSTRAINT "product_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deals" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "status" "DealStatus" NOT NULL DEFAULT 'DRAFT',
    "approvalStage" "ApprovalStage" NOT NULL DEFAULT 'CANDIDATE',
    "telegramChatId" TEXT,
    "telegramMessageId" INTEGER,
    "sourceUrlRaw" TEXT,
    "pendingInput" "PendingInput",
    "parseSource" TEXT,
    "parseFieldCount" INTEGER NOT NULL DEFAULT 0,
    "salePrice" INTEGER,
    "discountRate" INTEGER,
    "couponCode" TEXT,
    "couponDesc" TEXT,
    "couponExpiresAt" TIMESTAMP(3),
    "finalPrice" INTEGER,
    "endsAt" TIMESTAMP(3),
    "hookLine" TEXT,
    "curatorNote" TEXT,
    "aiScore" DOUBLE PRECISION,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "curator_links" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "variantId" TEXT,
    "rawUrl" TEXT NOT NULL,
    "ulid" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT true,
    "health" "LinkHealth" NOT NULL DEFAULT 'UNCHECKED',
    "healthCheckedAt" TIMESTAMP(3),
    "soldoutStreak" INTEGER NOT NULL DEFAULT 0,
    "healthCheckAfter" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "curator_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_cards" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "channel" "Channel" NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "bodyText" TEXT NOT NULL,
    "charCount" INTEGER NOT NULL,
    "disclosureOk" BOOLEAN NOT NULL,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "warnings" TEXT,
    "aiGeneratedFields" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_cards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "posts" (
    "id" TEXT NOT NULL,
    "contentCardId" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "channel" "Channel" NOT NULL,
    "mode" "PostMode" NOT NULL,
    "status" "PostStatus" NOT NULL DEFAULT 'PENDING',
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "short_links" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "curatorLinkId" TEXT NOT NULL,
    "surface" TEXT NOT NULL DEFAULT 'hub',
    "targetUrl" TEXT NOT NULL,
    "state" "ShortLinkState" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "short_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "click_events" (
    "id" TEXT NOT NULL,
    "shortLinkId" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "referer" TEXT,
    "uaClass" TEXT NOT NULL DEFAULT 'human',
    "country" TEXT,

    CONSTRAINT "click_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor" "Actor" NOT NULL,
    "action" TEXT NOT NULL,
    "channel" TEXT,
    "approvalRef" TEXT,
    "payloadHash" TEXT,
    "payloadSnapshot" TEXT,
    "responseCode" INTEGER,
    "responseId" TEXT,
    "detail" TEXT,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fetch_log" (
    "id" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "url" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "trigger" "FetchTrigger" NOT NULL,
    "outcome" "FetchOutcome" NOT NULL,
    "responseCode" INTEGER,
    "durationMs" INTEGER,
    "bytes" INTEGER,
    "detail" TEXT,

    CONSTRAINT "fetch_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "circuit_state" (
    "host" TEXT NOT NULL,
    "state" "Circuit" NOT NULL DEFAULT 'HEALTHY',
    "pausedUntil" TIMESTAMP(3),
    "reason" TEXT,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "circuit_state_pkey" PRIMARY KEY ("host")
);

-- CreateTable
CREATE TABLE "price_snapshots" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "listPrice" INTEGER,
    "salePrice" INTEGER,
    "couponPrice" INTEGER,
    "source" "SnapshotSource" NOT NULL,
    "eventTag" TEXT,
    "note" TEXT,

    CONSTRAINT "price_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "watch_items" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "checkAfter" TIMESTAMP(3) NOT NULL,
    "lastCheckedAt" TIMESTAMP(3),

    CONSTRAINT "watch_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policy" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "note" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "policy_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "album_captures" (
    "mediaGroupId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "sourceMessageId" INTEGER NOT NULL,
    "statusMessageId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "album_captures_pkey" PRIMARY KEY ("mediaGroupId")
);

-- CreateTable
CREATE TABLE "album_capture_photos" (
    "id" TEXT NOT NULL,
    "mediaGroupId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "album_capture_photos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "creators_handle_key" ON "creators"("handle");

-- CreateIndex
CREATE UNIQUE INDEX "products_creatorId_musinsaGoodsNo_key" ON "products"("creatorId", "musinsaGoodsNo");

-- CreateIndex
CREATE UNIQUE INDEX "content_cards_dealId_channel_version_key" ON "content_cards"("dealId", "channel", "version");

-- CreateIndex
CREATE UNIQUE INDEX "short_links_code_key" ON "short_links"("code");

-- CreateIndex
CREATE UNIQUE INDEX "short_links_dealId_curatorLinkId_surface_key" ON "short_links"("dealId", "curatorLinkId", "surface");

-- CreateIndex
CREATE INDEX "click_events_shortLinkId_ts_idx" ON "click_events"("shortLinkId", "ts");

-- CreateIndex
CREATE INDEX "audit_log_ts_idx" ON "audit_log"("ts");

-- CreateIndex
CREATE INDEX "audit_log_approvalRef_idx" ON "audit_log"("approvalRef");

-- CreateIndex
CREATE INDEX "fetch_log_ts_idx" ON "fetch_log"("ts");

-- CreateIndex
CREATE INDEX "fetch_log_host_ts_idx" ON "fetch_log"("host", "ts");

-- CreateIndex
CREATE INDEX "price_snapshots_productId_capturedAt_idx" ON "price_snapshots"("productId", "capturedAt");

-- CreateIndex
CREATE UNIQUE INDEX "watch_items_productId_key" ON "watch_items"("productId");

-- CreateIndex
CREATE INDEX "album_capture_photos_mediaGroupId_createdAt_idx" ON "album_capture_photos"("mediaGroupId", "createdAt");

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "creators"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "creators"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "curator_links" ADD CONSTRAINT "curator_links_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "deals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "curator_links" ADD CONSTRAINT "curator_links_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_cards" ADD CONSTRAINT "content_cards_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "deals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "posts" ADD CONSTRAINT "posts_contentCardId_fkey" FOREIGN KEY ("contentCardId") REFERENCES "content_cards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "posts" ADD CONSTRAINT "posts_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "deals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "short_links" ADD CONSTRAINT "short_links_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "deals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "short_links" ADD CONSTRAINT "short_links_curatorLinkId_fkey" FOREIGN KEY ("curatorLinkId") REFERENCES "curator_links"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "click_events" ADD CONSTRAINT "click_events_shortLinkId_fkey" FOREIGN KEY ("shortLinkId") REFERENCES "short_links"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_snapshots" ADD CONSTRAINT "price_snapshots_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "watch_items" ADD CONSTRAINT "watch_items_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "album_capture_photos" ADD CONSTRAINT "album_capture_photos_mediaGroupId_fkey" FOREIGN KEY ("mediaGroupId") REFERENCES "album_captures"("mediaGroupId") ON DELETE CASCADE ON UPDATE CASCADE;

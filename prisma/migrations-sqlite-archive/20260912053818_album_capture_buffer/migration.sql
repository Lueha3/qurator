-- CreateTable
CREATE TABLE "album_captures" (
    "mediaGroupId" TEXT NOT NULL PRIMARY KEY,
    "chatId" TEXT NOT NULL,
    "sourceMessageId" INTEGER NOT NULL,
    "statusMessageId" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "album_capture_photos" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "mediaGroupId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "album_capture_photos_mediaGroupId_fkey" FOREIGN KEY ("mediaGroupId") REFERENCES "album_captures" ("mediaGroupId") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "album_capture_photos_mediaGroupId_createdAt_idx" ON "album_capture_photos"("mediaGroupId", "createdAt");

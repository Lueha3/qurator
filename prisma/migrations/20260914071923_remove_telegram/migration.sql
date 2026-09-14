/*
  Warnings:

  - You are about to drop the column `pendingInput` on the `deals` table. All the data in the column will be lost.
  - You are about to drop the column `telegramChatId` on the `deals` table. All the data in the column will be lost.
  - You are about to drop the column `telegramMessageId` on the `deals` table. All the data in the column will be lost.
  - You are about to drop the `album_capture_photos` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `album_captures` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "album_capture_photos" DROP CONSTRAINT "album_capture_photos_mediaGroupId_fkey";

-- AlterTable
ALTER TABLE "deals" DROP COLUMN "pendingInput",
DROP COLUMN "telegramChatId",
DROP COLUMN "telegramMessageId";

-- DropTable
DROP TABLE "album_capture_photos";

-- DropTable
DROP TABLE "album_captures";

-- DropEnum
DROP TYPE "PendingInput";

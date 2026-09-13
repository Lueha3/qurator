/*
  Warnings:

  - Added the required column `checkAfter` to the `watch_items` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_watch_items" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "productId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "checkAfter" DATETIME NOT NULL,
    "lastCheckedAt" DATETIME,
    CONSTRAINT "watch_items_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_watch_items" ("active", "createdAt", "expiresAt", "id", "productId") SELECT "active", "createdAt", "expiresAt", "id", "productId" FROM "watch_items";
DROP TABLE "watch_items";
ALTER TABLE "new_watch_items" RENAME TO "watch_items";
CREATE UNIQUE INDEX "watch_items_productId_key" ON "watch_items"("productId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

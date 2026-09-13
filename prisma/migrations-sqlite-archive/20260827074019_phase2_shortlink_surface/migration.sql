/*
  Warnings:

  - You are about to drop the column `channel` on the `short_links` table. All the data in the column will be lost.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_short_links" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "curatorLinkId" TEXT NOT NULL,
    "surface" TEXT NOT NULL DEFAULT 'hub',
    "targetUrl" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "short_links_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "deals" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "short_links_curatorLinkId_fkey" FOREIGN KEY ("curatorLinkId") REFERENCES "curator_links" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_short_links" ("code", "createdAt", "curatorLinkId", "dealId", "id", "state", "targetUrl") SELECT "code", "createdAt", "curatorLinkId", "dealId", "id", "state", "targetUrl" FROM "short_links";
DROP TABLE "short_links";
ALTER TABLE "new_short_links" RENAME TO "short_links";
CREATE UNIQUE INDEX "short_links_code_key" ON "short_links"("code");
CREATE UNIQUE INDEX "short_links_dealId_curatorLinkId_surface_key" ON "short_links"("dealId", "curatorLinkId", "surface");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

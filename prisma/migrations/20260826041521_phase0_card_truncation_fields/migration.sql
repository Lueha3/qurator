-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_content_cards" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "dealId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "bodyText" TEXT NOT NULL,
    "charCount" INTEGER NOT NULL,
    "disclosureOk" BOOLEAN NOT NULL,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "warnings" TEXT,
    "aiGeneratedFields" TEXT,
    "approvedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "content_cards_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "deals" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_content_cards" ("aiGeneratedFields", "approvedAt", "bodyText", "channel", "charCount", "createdAt", "dealId", "disclosureOk", "id", "version") SELECT "aiGeneratedFields", "approvedAt", "bodyText", "channel", "charCount", "createdAt", "dealId", "disclosureOk", "id", "version" FROM "content_cards";
DROP TABLE "content_cards";
ALTER TABLE "new_content_cards" RENAME TO "content_cards";
CREATE UNIQUE INDEX "content_cards_dealId_channel_version_key" ON "content_cards"("dealId", "channel", "version");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

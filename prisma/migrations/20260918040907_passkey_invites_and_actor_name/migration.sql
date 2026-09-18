-- CreateTable
CREATE TABLE "passkey_invites" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "note" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "passkey_invites_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "passkey_invites_code_key" ON "passkey_invites"("code");

-- CreateIndex
CREATE INDEX "passkey_invites_expiresAt_idx" ON "passkey_invites"("expiresAt");

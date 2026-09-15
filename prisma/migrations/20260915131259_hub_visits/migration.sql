-- CreateTable
CREATE TABLE "hub_visits" (
    "id" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uaClass" TEXT NOT NULL DEFAULT 'human',

    CONSTRAINT "hub_visits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "hub_visits_ts_idx" ON "hub_visits"("ts");

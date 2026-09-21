-- AlterEnum
ALTER TYPE "SnapshotSource" ADD VALUE 'CORRECTED';

-- AlterTable
ALTER TABLE "deals" ADD COLUMN     "visionConfidence" TEXT,
ADD COLUMN     "visionNotes" TEXT;

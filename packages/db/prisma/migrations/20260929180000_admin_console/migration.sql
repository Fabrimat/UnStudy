-- AlterTable
ALTER TABLE "CreditLedger" ADD COLUMN     "adminId" UUID,
ADD COLUMN     "note" TEXT;

-- CreateTable
CREATE TABLE "ModelPreset" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "multiplier" DOUBLE PRECISION NOT NULL,
    "temperature" DOUBLE PRECISION,
    "priceIn" DOUBLE PRECISION,
    "priceOut" DOUBLE PRECISION,
    "adminOnly" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModelPreset_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "CreditLedger" ADD CONSTRAINT "CreditLedger_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


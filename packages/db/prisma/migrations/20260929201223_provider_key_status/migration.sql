-- CreateTable
CREATE TABLE "ProviderKeyStatus" (
    "id" TEXT NOT NULL,
    "hasKey" BOOLEAN NOT NULL,
    "source" TEXT NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderKeyStatus_pkey" PRIMARY KEY ("id")
);

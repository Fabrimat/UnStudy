-- CreateTable
CREATE TABLE "LlmProvider" (
    "id" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "tokenParam" TEXT NOT NULL DEFAULT 'max_tokens',
    "maxConcurrency" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LlmProvider_pkey" PRIMARY KEY ("id")
);

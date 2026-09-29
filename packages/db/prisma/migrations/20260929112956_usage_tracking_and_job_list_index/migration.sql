-- CreateEnum
CREATE TYPE "LlmPhase" AS ENUM ('draft', 'verify');

-- AlterTable
ALTER TABLE "Job" ADD COLUMN     "durationMs" INTEGER,
ADD COLUMN     "model" TEXT;

-- CreateTable
CREATE TABLE "LlmCall" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "jobId" UUID NOT NULL,
    "attempt" INTEGER NOT NULL,
    "chapter" INTEGER NOT NULL,
    "phase" "LlmPhase" NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LlmCall_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LlmCall_jobId_idx" ON "LlmCall"("jobId");

-- CreateIndex
CREATE INDEX "LlmCall_model_createdAt_idx" ON "LlmCall"("model", "createdAt");

-- CreateIndex
CREATE INDEX "Job_userId_kind_createdAt_idx" ON "Job"("userId", "kind", "createdAt");

-- AddForeignKey
ALTER TABLE "LlmCall" ADD CONSTRAINT "LlmCall_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

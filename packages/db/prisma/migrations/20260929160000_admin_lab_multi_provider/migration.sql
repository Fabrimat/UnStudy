-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('user', 'admin');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "role" "UserRole" NOT NULL DEFAULT 'user';

-- AlterTable
ALTER TABLE "Job" ADD COLUMN     "benchmarkId" UUID;

-- AlterTable
ALTER TABLE "LlmCall" ADD COLUMN     "modelId" TEXT,
ADD COLUMN     "provider" TEXT;

-- CreateTable
CREATE TABLE "Benchmark" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "options" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Benchmark_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Benchmark_userId_createdAt_idx" ON "Benchmark"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Job_benchmarkId_idx" ON "Job"("benchmarkId");

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_benchmarkId_fkey" FOREIGN KEY ("benchmarkId") REFERENCES "Benchmark"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Benchmark" ADD CONSTRAINT "Benchmark_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Benchmark" ADD CONSTRAINT "Benchmark_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;


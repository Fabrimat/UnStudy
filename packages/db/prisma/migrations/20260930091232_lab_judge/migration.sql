-- AlterEnum
ALTER TYPE "LlmPhase" ADD VALUE 'judge';

-- AlterTable
ALTER TABLE "Job" ADD COLUMN     "evaluation" JSONB;

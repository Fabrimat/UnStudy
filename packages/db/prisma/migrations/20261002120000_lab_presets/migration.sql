-- CreateTable
CREATE TABLE "LabPreset" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "judge" TEXT,
    "lanes" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LabPreset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LabPreset_name_key" ON "LabPreset"("name");

-- Seed
INSERT INTO "LabPreset" ("id", "name", "judge", "lanes", "updatedAt") VALUES
(gen_random_uuid(), 'Benchmark 4 – classica vs harness', 'gpt-6-sol', '[
{"draft":"gpt-6-sol","verify":"gpt-6-sol"},{"draft":"gpt-6-sol","verify":"gpt-6-sol","harness":true},
{"draft":"gpt-6-luna","verify":"gpt-6-luna"},{"draft":"gpt-6-luna","verify":"gpt-6-luna","harness":true},
{"draft":"nemotron-ultra","verify":"nemotron-ultra"},{"draft":"nemotron-ultra","verify":"nemotron-ultra","harness":true},
{"draft":"glm-5-3-flash","verify":"glm-5-3-flash"},{"draft":"glm-5-3-flash","verify":"glm-5-3-flash","harness":true}
]'::jsonb, now()),
(gen_random_uuid(), 'Benchmark 4b – giudice come critico', 'gpt-6-sol', '[
{"draft":"gpt-6-luna","verify":"gpt-6-sol","harness":true},
{"draft":"nemotron-ultra","verify":"gpt-6-sol","harness":true},
{"draft":"nemotron-super","verify":"gpt-6-sol","harness":true},
{"draft":"glm-5-3-flash","verify":"gpt-6-sol","harness":true},
{"draft":"deepseek-v4-1-flash","verify":"gpt-6-sol","harness":true},
{"draft":"kimi-k3","verify":"gpt-6-sol","harness":true}
]'::jsonb, now());

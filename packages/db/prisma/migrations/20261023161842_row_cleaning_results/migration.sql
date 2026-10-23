-- CreateEnum
CREATE TYPE "RowCleaningOutcome" AS ENUM ('READY', 'NEEDS_REVIEW', 'FAILED');

-- CreateTable
CREATE TABLE "RowCleaningResult" (
    "id" UUID NOT NULL,
    "sourceRowId" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "cleanerVersion" TEXT NOT NULL,
    "configHash" VARCHAR(64) NOT NULL,
    "configSnapshot" JSONB NOT NULL,
    "normalized" JSONB NOT NULL,
    "evidence" JSONB NOT NULL,
    "issues" JSONB NOT NULL,
    "outcome" "RowCleaningOutcome" NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RowCleaningResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RowCleaningResult_sourceRowId_cleanerVersion_configHash_key" ON "RowCleaningResult"("sourceRowId", "cleanerVersion", "configHash");

-- AddForeignKey
ALTER TABLE "RowCleaningResult" ADD CONSTRAINT "RowCleaningResult_sourceRowId_storeId_fkey" FOREIGN KEY ("sourceRowId", "storeId") REFERENCES "SourceRow"("id", "storeId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Prisma cannot represent these JSON shape and content checks directly.
ALTER TABLE "RowCleaningResult"
    ADD CONSTRAINT "RowCleaningResult_configHash_sha256" CHECK ("configHash" ~ '^[0-9a-f]{64}$'),
    ADD CONSTRAINT "RowCleaningResult_cleanerVersion_nonblank" CHECK (length(btrim("cleanerVersion")) > 0),
    ADD CONSTRAINT "RowCleaningResult_configSnapshot_object" CHECK (jsonb_typeof("configSnapshot") = 'object'),
    ADD CONSTRAINT "RowCleaningResult_normalized_object" CHECK (jsonb_typeof("normalized") = 'object'),
    ADD CONSTRAINT "RowCleaningResult_evidence_object" CHECK (jsonb_typeof("evidence") = 'object'),
    ADD CONSTRAINT "RowCleaningResult_issues_array" CHECK (jsonb_typeof("issues") = 'array');

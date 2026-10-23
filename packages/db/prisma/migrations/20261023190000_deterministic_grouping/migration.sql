BEGIN;
-- CreateEnum
CREATE TYPE "GroupingRunStatus" AS ENUM ('PENDING', 'COMPLETED');

-- CreateEnum
CREATE TYPE "GroupingRowOutcome" AS ENUM ('PENDING', 'APPLIED', 'NEEDS_REVIEW', 'FAILED');

-- AlterTable
ALTER TABLE "ProductRevision" ADD COLUMN     "groupingRunId" UUID;

-- AlterTable
ALTER TABLE "RevisionSourceRow" ADD COLUMN     "cleaningResultId" UUID;

-- CreateTable
CREATE TABLE "GroupingRun" (
    "id" UUID NOT NULL,
    "importId" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "grouperVersion" TEXT NOT NULL,
    "configHash" VARCHAR(64) NOT NULL,
    "configSnapshot" JSONB NOT NULL,
    "inputHash" VARCHAR(64) NOT NULL,
    "plan" JSONB NOT NULL,
    "status" "GroupingRunStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(3),

    CONSTRAINT "GroupingRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupingRowResult" (
    "runId" UUID NOT NULL,
    "importId" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "sourceRowId" UUID NOT NULL,
    "cleaningResultId" UUID NOT NULL,
    "groupKey" TEXT NOT NULL,
    "outcome" "GroupingRowOutcome" NOT NULL DEFAULT 'PENDING',
    "issues" JSONB NOT NULL DEFAULT '[]',
    "productRevisionId" UUID,
    "variantId" UUID,

    CONSTRAINT "GroupingRowResult_pkey" PRIMARY KEY ("runId","sourceRowId")
);

-- CreateIndex
CREATE UNIQUE INDEX "GroupingRun_importId_key" ON "GroupingRun"("importId");

-- CreateIndex
CREATE UNIQUE INDEX "GroupingRun_importId_storeId_key" ON "GroupingRun"("importId", "storeId");

-- CreateIndex
CREATE UNIQUE INDEX "GroupingRun_id_importId_storeId_key" ON "GroupingRun"("id", "importId", "storeId");

-- CreateIndex
CREATE INDEX "GroupingRowResult_runId_groupKey_idx" ON "GroupingRowResult"("runId", "groupKey");

-- CreateIndex
CREATE UNIQUE INDEX "ProductRevision_id_groupingRunId_storeId_key" ON "ProductRevision"("id", "groupingRunId", "storeId");

-- CreateIndex
CREATE UNIQUE INDEX "RowCleaningResult_id_sourceRowId_storeId_key" ON "RowCleaningResult"("id", "sourceRowId", "storeId");

-- CreateIndex
CREATE UNIQUE INDEX "SourceRow_id_importId_storeId_key" ON "SourceRow"("id", "importId", "storeId");

-- AddForeignKey
ALTER TABLE "ProductRevision" ADD CONSTRAINT "ProductRevision_groupingRunId_originImportId_storeId_fkey" FOREIGN KEY ("groupingRunId", "originImportId", "storeId") REFERENCES "GroupingRun"("id", "importId", "storeId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RevisionSourceRow" ADD CONSTRAINT "RevisionSourceRow_cleaningResultId_sourceRowId_storeId_fkey" FOREIGN KEY ("cleaningResultId", "sourceRowId", "storeId") REFERENCES "RowCleaningResult"("id", "sourceRowId", "storeId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "GroupingRun" ADD CONSTRAINT "GroupingRun_importId_storeId_fkey" FOREIGN KEY ("importId", "storeId") REFERENCES "Import"("id", "storeId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "GroupingRowResult" ADD CONSTRAINT "GroupingRowResult_runId_importId_storeId_fkey" FOREIGN KEY ("runId", "importId", "storeId") REFERENCES "GroupingRun"("id", "importId", "storeId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "GroupingRowResult" ADD CONSTRAINT "GroupingRowResult_sourceRowId_importId_storeId_fkey" FOREIGN KEY ("sourceRowId", "importId", "storeId") REFERENCES "SourceRow"("id", "importId", "storeId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "GroupingRowResult" ADD CONSTRAINT "GroupingRowResult_cleaningResultId_sourceRowId_storeId_fkey" FOREIGN KEY ("cleaningResultId", "sourceRowId", "storeId") REFERENCES "RowCleaningResult"("id", "sourceRowId", "storeId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "GroupingRowResult" ADD CONSTRAINT "GroupingRowResult_productRevisionId_runId_storeId_fkey" FOREIGN KEY ("productRevisionId", "runId", "storeId") REFERENCES "ProductRevision"("id", "groupingRunId", "storeId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "GroupingRowResult" ADD CONSTRAINT "GroupingRowResult_productRevisionId_variantId_fkey" FOREIGN KEY ("productRevisionId", "variantId") REFERENCES "VariantRevision"("productRevisionId", "variantId") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- Freeze inputs and the complete preflight plan; allow progress and normal cleanup.
CREATE FUNCTION public.catalogforge_freeze_grouping_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['status','finishedAt']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','finishedAt']) THEN
    RAISE EXCEPTION 'GroupingRun inputs and plan are immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'COMPLETED' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Completed GroupingRun is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'COMPLETED' AND (
    NEW."finishedAt" IS NULL OR
    EXISTS (SELECT 1 FROM "GroupingRowResult" WHERE "runId" = NEW.id AND outcome = 'PENDING') OR
    (SELECT count(*) FROM "GroupingRowResult" WHERE "runId" = NEW.id) IS DISTINCT FROM
      (SELECT "totalRows"::bigint FROM "Import" WHERE id = NEW."importId")
  ) THEN RAISE EXCEPTION 'GroupingRun completion requires exact terminal row outcomes' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER "GroupingRun_frozen_inputs" BEFORE UPDATE ON "GroupingRun"
FOR EACH ROW EXECUTE FUNCTION public.catalogforge_freeze_grouping_run();

CREATE FUNCTION public.catalogforge_freeze_grouping_selection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['outcome','issues','productRevisionId','variantId']) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['outcome','issues','productRevisionId','variantId']) OR
     (OLD.outcome <> 'PENDING' AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'GroupingRowResult selection and terminal outcomes are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER "GroupingRowResult_frozen_selection" BEFORE UPDATE ON "GroupingRowResult"
FOR EACH ROW EXECUTE FUNCTION public.catalogforge_freeze_grouping_selection();

ALTER TABLE "GroupingRun"
  ADD CONSTRAINT "GroupingRun_hashes" CHECK ("configHash" ~ '^[0-9a-f]{64}$' AND "inputHash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "GroupingRun_json" CHECK (jsonb_typeof("configSnapshot") = 'object' AND jsonb_typeof(plan) = 'object'),
  ADD CONSTRAINT "GroupingRun_version" CHECK (length(btrim("grouperVersion")) > 0);
ALTER TABLE "GroupingRowResult"
  ADD CONSTRAINT "GroupingRowResult_issues" CHECK (jsonb_typeof(issues) = 'array'),
  ADD CONSTRAINT "GroupingRowResult_variant_requires_revision" CHECK ("variantId" IS NULL OR "productRevisionId" IS NOT NULL);
ALTER TABLE "ProductRevision" ADD CONSTRAINT "ProductRevision_grouping_origin" CHECK ("groupingRunId" IS NULL OR "originImportId" IS NOT NULL);
COMMIT;

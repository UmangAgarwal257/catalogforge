-- CreateTable
CREATE TABLE "AIEnrichmentRun" (
    "id" UUID NOT NULL,
    "revisionId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "inputHash" VARCHAR(64) NOT NULL,
    "policyHash" VARCHAR(64) NOT NULL,
    "inputSnapshot" JSONB NOT NULL,
    "policySnapshot" JSONB NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "fence" INTEGER NOT NULL DEFAULT 0,
    "leaseUntil" TIMESTAMPTZ(3),
    "nextAttemptAt" TIMESTAMPTZ(3),
    "result" JSONB,
    "errorCode" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(3),

    CONSTRAINT "AIEnrichmentRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AIEnrichmentAttempt" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "fence" INTEGER NOT NULL,
    "model" TEXT NOT NULL,
    "requestId" TEXT,
    "state" TEXT NOT NULL DEFAULT 'STARTED',
    "usageKind" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "estimatedMicroUsd" INTEGER,
    "reservedMicroUsd" INTEGER NOT NULL,
    "output" JSONB,
    "errorCode" TEXT,
    "latencyMs" INTEGER,
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(3),

    CONSTRAINT "AIEnrichmentAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AIEnrichmentRun_revisionId_inputHash_policyHash_key" ON "AIEnrichmentRun"("revisionId", "inputHash", "policyHash");

-- CreateIndex
CREATE UNIQUE INDEX "AIEnrichmentRun_id_storeId_key" ON "AIEnrichmentRun"("id", "storeId");

-- CreateIndex
CREATE UNIQUE INDEX "AIEnrichmentAttempt_runId_number_key" ON "AIEnrichmentAttempt"("runId", "number");

-- AddForeignKey
ALTER TABLE "AIEnrichmentRun" ADD CONSTRAINT "AIEnrichmentRun_revisionId_productId_storeId_fkey" FOREIGN KEY ("revisionId", "productId", "storeId") REFERENCES "ProductRevision"("id", "productId", "storeId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AIEnrichmentAttempt" ADD CONSTRAINT "AIEnrichmentAttempt_runId_storeId_fkey" FOREIGN KEY ("runId", "storeId") REFERENCES "AIEnrichmentRun"("id", "storeId") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- Prisma does not express these state/audit checks or frozen-input triggers.
ALTER TABLE "AIEnrichmentRun" ADD CONSTRAINT "ai_run_shape" CHECK (
  "inputHash" ~ '^[0-9a-f]{64}$' AND "policyHash" ~ '^[0-9a-f]{64}$' AND fence >= 0
  AND jsonb_typeof("inputSnapshot") = 'object' AND jsonb_typeof("policySnapshot") = 'object'
  AND state IN ('PENDING','RUNNING','RETRY_WAIT','COMPLETED','FAILED','STALE','BUDGET_EXHAUSTED')
  AND (state <> 'COMPLETED' OR (result IS NOT NULL AND "finishedAt" IS NOT NULL)));
ALTER TABLE "AIEnrichmentAttempt" ADD CONSTRAINT "ai_attempt_shape" CHECK (
  number BETWEEN 1 AND 3 AND fence > 0 AND "reservedMicroUsd" >= 0
  AND ("estimatedMicroUsd" IS NULL OR "estimatedMicroUsd" >= 0)
  AND ("inputTokens" IS NULL OR "inputTokens" >= 0) AND ("outputTokens" IS NULL OR "outputTokens" >= 0)
  AND ("latencyMs" IS NULL OR "latencyMs" >= 0)
  AND state IN ('STARTED','UNKNOWN','ERROR','RESPONSE_SAVED') AND "usageKind" IN ('UNKNOWN','MOCK','REPORTED'));
CREATE FUNCTION catalogforge_freeze_ai_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW."revisionId", NEW."productId", NEW."storeId", NEW."inputHash", NEW."policyHash", NEW."inputSnapshot", NEW."policySnapshot", NEW."createdAt")
    IS DISTINCT FROM ROW(OLD.id, OLD."revisionId", OLD."productId", OLD."storeId", OLD."inputHash", OLD."policyHash", OLD."inputSnapshot", OLD."policySnapshot", OLD."createdAt")
    OR (OLD.state IN ('COMPLETED','FAILED','STALE','BUDGET_EXHAUSTED') AND NEW IS DISTINCT FROM OLD)
    OR NEW.fence < OLD.fence THEN
    RAISE EXCEPTION 'AI run inputs and terminal outcomes are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER freeze_ai_run BEFORE UPDATE ON "AIEnrichmentRun" FOR EACH ROW EXECUTE FUNCTION catalogforge_freeze_ai_run();
CREATE FUNCTION catalogforge_freeze_ai_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW."runId", NEW."storeId", NEW.number, NEW.fence, NEW."reservedMicroUsd", NEW."startedAt")
    IS DISTINCT FROM ROW(OLD.id, OLD."runId", OLD."storeId", OLD.number, OLD.fence, OLD."reservedMicroUsd", OLD."startedAt")
    OR (OLD.state <> 'STARTED' AND ROW(NEW.output, NEW."inputTokens", NEW."outputTokens", NEW."estimatedMicroUsd", NEW."usageKind", NEW."requestId", NEW."latencyMs", NEW.model)
      IS DISTINCT FROM ROW(OLD.output, OLD."inputTokens", OLD."outputTokens", OLD."estimatedMicroUsd", OLD."usageKind", OLD."requestId", OLD."latencyMs", OLD.model)) THEN
    RAISE EXCEPTION 'AI attempt identity and recorded usage/output are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER freeze_ai_attempt BEFORE UPDATE ON "AIEnrichmentAttempt" FOR EACH ROW EXECUTE FUNCTION catalogforge_freeze_ai_attempt();

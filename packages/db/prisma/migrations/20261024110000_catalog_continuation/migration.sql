-- CreateTable
CREATE TABLE "CatalogTask" (
    "importId" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "phase" TEXT NOT NULL DEFAULT 'CLEANING',
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "fence" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "leaseUntil" TIMESTAMPTZ(3),
    "nextAttemptAt" TIMESTAMPTZ(3),
    "runs" JSONB NOT NULL DEFAULT '{}',
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CatalogTask_pkey" PRIMARY KEY ("importId")
);

-- CreateIndex
CREATE INDEX "CatalogTask_storeId_state_nextAttemptAt_idx" ON "CatalogTask"("storeId", "state", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogTask_importId_storeId_key" ON "CatalogTask"("importId", "storeId");

-- AddForeignKey
ALTER TABLE "CatalogTask" ADD CONSTRAINT "CatalogTask_importId_storeId_fkey" FOREIGN KEY ("importId", "storeId") REFERENCES "Import"("id", "storeId") ON DELETE CASCADE ON UPDATE RESTRICT;

-- The coordinator owns only catalog continuation; child runs retain business outcomes.
ALTER TABLE "CatalogTask" ADD CONSTRAINT "CatalogTask_shape_check" CHECK (
 "phase" IN ('CLEANING','GROUPING','ENRICHMENT') AND
 "state" IN ('PENDING','RUNNING','WAITING','NEEDS_MAPPING','FAILED','COMPLETED') AND
 "fence" >= 0 AND "attempts" >= 0 AND jsonb_typeof("runs") = 'object'
);

-- CreateTable
CREATE TABLE "ProductReviewEvent" (
    "id" UUID NOT NULL,
    "revisionId" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "requestHash" VARCHAR(64) NOT NULL,
    "action" TEXT NOT NULL,
    "beforeVersion" INTEGER NOT NULL,
    "afterVersion" INTEGER NOT NULL,
    "changes" JSONB NOT NULL,
    "decisions" JSONB NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductReviewEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProductReviewEvent_revisionId_requestId_key" ON "ProductReviewEvent"("revisionId", "requestId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductReviewEvent_revisionId_afterVersion_key" ON "ProductReviewEvent"("revisionId", "afterVersion");

-- AddForeignKey
ALTER TABLE "ProductReviewEvent" ADD CONSTRAINT "ProductReviewEvent_revisionId_storeId_fkey" FOREIGN KEY ("revisionId", "storeId") REFERENCES "ProductRevision"("id", "storeId") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "ProductReviewEvent" ADD CONSTRAINT "review_event_shape" CHECK (
  action IN ('EDIT','APPROVE','REJECT') AND "beforeVersion" > 0 AND "afterVersion" = "beforeVersion" + 1
  AND "requestHash" ~ '^[a-f0-9]{64}$' AND jsonb_typeof(changes) = 'object' AND jsonb_typeof(decisions) = 'array');

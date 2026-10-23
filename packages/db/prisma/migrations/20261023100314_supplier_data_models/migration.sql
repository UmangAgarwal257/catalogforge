-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('PENDING', 'PROCESSING', 'PAUSED', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "SourceRowStatus" AS ENUM ('PENDING', 'PROCESSING', 'DONE', 'NEEDS_REVIEW', 'FAILED');

-- CreateTable
CREATE TABLE "Store" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Store_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Supplier" (
    "id" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Import" (
    "id" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "supplierId" UUID NOT NULL,
    "originalFilename" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "fileSha256" VARCHAR(64) NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "parserVersion" TEXT NOT NULL,
    "mappingConfig" JSONB NOT NULL DEFAULT '{}',
    "status" "ImportStatus" NOT NULL DEFAULT 'PENDING',
    "totalRows" INTEGER,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMPTZ(3),
    "finishedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Import_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourceRow" (
    "id" UUID NOT NULL,
    "importId" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "sheetIndex" INTEGER NOT NULL,
    "sheetName" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "rawCells" JSONB NOT NULL,
    "rowFingerprint" TEXT,
    "status" "SourceRowStatus" NOT NULL DEFAULT 'PENDING',
    "issues" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SourceRow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Supplier_storeId_idx" ON "Supplier"("storeId");

-- CreateIndex
CREATE UNIQUE INDEX "Supplier_id_storeId_key" ON "Supplier"("id", "storeId");

-- CreateIndex
CREATE INDEX "Import_storeId_status_idx" ON "Import"("storeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Import_id_storeId_key" ON "Import"("id", "storeId");

-- CreateIndex
CREATE UNIQUE INDEX "Import_storeId_supplierId_idempotencyKey_key" ON "Import"("storeId", "supplierId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "SourceRow_importId_status_idx" ON "SourceRow"("importId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SourceRow_importId_sheetIndex_rowNumber_key" ON "SourceRow"("importId", "sheetIndex", "rowNumber");

-- AddForeignKey
ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Import" ADD CONSTRAINT "Import_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Import" ADD CONSTRAINT "Import_supplierId_storeId_fkey" FOREIGN KEY ("supplierId", "storeId") REFERENCES "Supplier"("id", "storeId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SourceRow" ADD CONSTRAINT "SourceRow_importId_storeId_fkey" FOREIGN KEY ("importId", "storeId") REFERENCES "Import"("id", "storeId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- PostgreSQL checks are maintained here because Prisma 7 cannot express them.
ALTER TABLE "Import"
    ADD CONSTRAINT "Import_totalRows_nonnegative" CHECK ("totalRows" IS NULL OR "totalRows" >= 0),
    ADD CONSTRAINT "Import_fileSha256_format" CHECK ("fileSha256" ~ '^[0-9A-Fa-f]{64}$'),
    ADD CONSTRAINT "Import_idempotencyKey_nonblank" CHECK (length(btrim("idempotencyKey")) > 0);

ALTER TABLE "SourceRow"
    ADD CONSTRAINT "SourceRow_sheetIndex_nonnegative" CHECK ("sheetIndex" >= 0),
    ADD CONSTRAINT "SourceRow_rowNumber_positive" CHECK ("rowNumber" > 0),
    ADD CONSTRAINT "SourceRow_rawCells_array" CHECK (jsonb_typeof("rawCells") = 'array'),
    ADD CONSTRAINT "SourceRow_issues_array" CHECK (jsonb_typeof("issues") = 'array');

-- Protect evidence after insertion, not processing state. DELETE remains normal.
CREATE FUNCTION "protect_source_row"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF ROW(NEW."id", NEW."importId", NEW."storeId", NEW."sheetIndex",
           NEW."sheetName", NEW."rowNumber", NEW."rawCells",
           NEW."rowFingerprint", NEW."createdAt")
       IS DISTINCT FROM
       ROW(OLD."id", OLD."importId", OLD."storeId", OLD."sheetIndex",
           OLD."sheetName", OLD."rowNumber", OLD."rawCells",
           OLD."rowFingerprint", OLD."createdAt") THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'SourceRow_source_immutable',
            MESSAGE = 'SourceRow source fields are immutable';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "SourceRow_protect_source"
BEFORE UPDATE ON "SourceRow"
FOR EACH ROW EXECUTE FUNCTION "protect_source_row"();

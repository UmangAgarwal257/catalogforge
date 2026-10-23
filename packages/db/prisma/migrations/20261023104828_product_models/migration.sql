/*
  Warnings:

  - A unique constraint covering the columns `[id,storeId]` on the table `SourceRow` will be added. If there are existing duplicate values, this will fail.

*/
BEGIN;

-- CreateEnum
CREATE TYPE "ProductRevisionStatus" AS ENUM ('DRAFT', 'NEEDS_REVIEW', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "Product" (
    "id" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "supplierId" UUID NOT NULL,
    "supplierProductKey" TEXT,
    "publishedRevisionId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archivedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Variant" (
    "id" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "sku" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archivedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Variant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductRevision" (
    "id" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "originImportId" UUID,
    "basePublishedRevisionId" UUID,
    "status" "ProductRevisionStatus" NOT NULL DEFAULT 'DRAFT',
    "title" TEXT,
    "descriptionHtml" TEXT,
    "categoryKey" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "reviewReasons" JSONB NOT NULL DEFAULT '[]',
    "manualFieldPaths" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "editVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMPTZ(3),

    CONSTRAINT "ProductRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VariantRevision" (
    "productRevisionId" UUID NOT NULL,
    "variantId" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "options" JSONB NOT NULL DEFAULT '{}',
    "priceMinor" BIGINT,
    "currency" VARCHAR(3),
    "weightGrams" INTEGER,
    "manualFieldPaths" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "VariantRevision_pkey" PRIMARY KEY ("productRevisionId","variantId")
);

-- CreateTable
CREATE TABLE "RevisionSourceRow" (
    "sourceRowId" UUID NOT NULL,
    "productRevisionId" UUID NOT NULL,
    "variantId" UUID,
    "storeId" UUID NOT NULL,

    CONSTRAINT "RevisionSourceRow_pkey" PRIMARY KEY ("sourceRowId","productRevisionId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Product_id_storeId_key" ON "Product"("id", "storeId");

-- CreateIndex
CREATE UNIQUE INDEX "Product_storeId_supplierId_supplierProductKey_key" ON "Product"("storeId", "supplierId", "supplierProductKey");

-- CreateIndex
CREATE INDEX "Variant_productId_idx" ON "Variant"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "Variant_id_productId_storeId_key" ON "Variant"("id", "productId", "storeId");

-- CreateIndex
CREATE UNIQUE INDEX "Variant_storeId_sku_key" ON "Variant"("storeId", "sku");

-- CreateIndex
CREATE INDEX "ProductRevision_productId_createdAt_idx" ON "ProductRevision"("productId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProductRevision_id_productId_storeId_key" ON "ProductRevision"("id", "productId", "storeId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductRevision_id_storeId_key" ON "ProductRevision"("id", "storeId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductRevision_originImportId_productId_key" ON "ProductRevision"("originImportId", "productId");

-- CreateIndex
CREATE INDEX "VariantRevision_variantId_idx" ON "VariantRevision"("variantId");

-- CreateIndex
CREATE INDEX "RevisionSourceRow_productRevisionId_variantId_idx" ON "RevisionSourceRow"("productRevisionId", "variantId");

-- CreateIndex
CREATE UNIQUE INDEX "SourceRow_id_storeId_key" ON "SourceRow"("id", "storeId");

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_supplierId_storeId_fkey" FOREIGN KEY ("supplierId", "storeId") REFERENCES "Supplier"("id", "storeId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_publishedRevisionId_id_storeId_fkey" FOREIGN KEY ("publishedRevisionId", "id", "storeId") REFERENCES "ProductRevision"("id", "productId", "storeId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Variant" ADD CONSTRAINT "Variant_productId_storeId_fkey" FOREIGN KEY ("productId", "storeId") REFERENCES "Product"("id", "storeId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ProductRevision" ADD CONSTRAINT "ProductRevision_productId_storeId_fkey" FOREIGN KEY ("productId", "storeId") REFERENCES "Product"("id", "storeId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ProductRevision" ADD CONSTRAINT "ProductRevision_originImportId_storeId_fkey" FOREIGN KEY ("originImportId", "storeId") REFERENCES "Import"("id", "storeId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ProductRevision" ADD CONSTRAINT "ProductRevision_basePublishedRevisionId_productId_storeId_fkey" FOREIGN KEY ("basePublishedRevisionId", "productId", "storeId") REFERENCES "ProductRevision"("id", "productId", "storeId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "VariantRevision" ADD CONSTRAINT "VariantRevision_productRevisionId_productId_storeId_fkey" FOREIGN KEY ("productRevisionId", "productId", "storeId") REFERENCES "ProductRevision"("id", "productId", "storeId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "VariantRevision" ADD CONSTRAINT "VariantRevision_variantId_productId_storeId_fkey" FOREIGN KEY ("variantId", "productId", "storeId") REFERENCES "Variant"("id", "productId", "storeId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RevisionSourceRow" ADD CONSTRAINT "RevisionSourceRow_sourceRowId_storeId_fkey" FOREIGN KEY ("sourceRowId", "storeId") REFERENCES "SourceRow"("id", "storeId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RevisionSourceRow" ADD CONSTRAINT "RevisionSourceRow_productRevisionId_storeId_fkey" FOREIGN KEY ("productRevisionId", "storeId") REFERENCES "ProductRevision"("id", "storeId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RevisionSourceRow" ADD CONSTRAINT "RevisionSourceRow_productRevisionId_variantId_fkey" FOREIGN KEY ("productRevisionId", "variantId") REFERENCES "VariantRevision"("productRevisionId", "variantId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Shared by the write trigger, canonical-form check, and raw-input SKU lookups.
-- Trim PostgreSQL POSIX whitespace at the edges; preserve internal characters.
CREATE FUNCTION public."catalogforge_canonical_sku"(text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
    SELECT lower(regexp_replace($1, '^[[:space:]]+|[[:space:]]+$', '', 'g'));
$$;

CREATE FUNCTION public."canonicalize_variant_sku"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    NEW."sku" := public."catalogforge_canonical_sku"(NEW."sku");
    RETURN NEW;
END;
$$;

CREATE TRIGGER "Variant_canonicalize_sku"
BEFORE INSERT OR UPDATE OF "sku" ON "Variant"
FOR EACH ROW EXECUTE FUNCTION public."canonicalize_variant_sku"();

ALTER TABLE "Variant"
    ADD CONSTRAINT "Variant_sku_canonical" CHECK ("sku" <> '' AND "sku" = public."catalogforge_canonical_sku"("sku"));

ALTER TABLE "Product"
    ADD CONSTRAINT "Product_supplierProductKey_nonblank" CHECK ("supplierProductKey" IS NULL OR length(btrim("supplierProductKey")) > 0);

ALTER TABLE "ProductRevision"
    ADD CONSTRAINT "ProductRevision_editVersion_positive" CHECK ("editVersion" > 0),
    ADD CONSTRAINT "ProductRevision_baseline_not_self" CHECK ("basePublishedRevisionId" IS NULL OR "basePublishedRevisionId" <> "id"),
    ADD CONSTRAINT "ProductRevision_attributes_object" CHECK (jsonb_typeof("attributes") = 'object'),
    ADD CONSTRAINT "ProductRevision_reviewReasons_array" CHECK (jsonb_typeof("reviewReasons") = 'array');

ALTER TABLE "VariantRevision"
    ADD CONSTRAINT "VariantRevision_options_object" CHECK (jsonb_typeof("options") = 'object'),
    ADD CONSTRAINT "VariantRevision_priceMinor_nonnegative" CHECK ("priceMinor" IS NULL OR "priceMinor" >= 0),
    ADD CONSTRAINT "VariantRevision_weightGrams_nonnegative" CHECK ("weightGrams" IS NULL OR "weightGrams" >= 0),
    ADD CONSTRAINT "VariantRevision_currency_format" CHECK ("currency" IS NULL OR "currency" ~ '^[A-Z]{3}$'),
    ADD CONSTRAINT "VariantRevision_price_requires_currency" CHECK ("priceMinor" IS NULL OR "currency" IS NOT NULL);

COMMIT;

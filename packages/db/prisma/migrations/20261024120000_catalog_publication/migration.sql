-- CreateTable
CREATE TABLE "ProductPublication" (
    "id" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "revisionId" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "requestHash" VARCHAR(64) NOT NULL,
    "expectedEditVersion" INTEGER NOT NULL,
    "previousRevisionId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductPublication_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProductPublication_revisionId_key" ON "ProductPublication"("revisionId");

-- CreateIndex
CREATE INDEX "ProductPublication_storeId_productId_idx" ON "ProductPublication"("storeId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductPublication_storeId_requestId_key" ON "ProductPublication"("storeId", "requestId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductPublication_revisionId_productId_storeId_key" ON "ProductPublication"("revisionId", "productId", "storeId");

-- AddForeignKey
ALTER TABLE "ProductPublication" ADD CONSTRAINT "ProductPublication_revisionId_productId_storeId_fkey" FOREIGN KEY ("revisionId", "productId", "storeId") REFERENCES "ProductRevision"("id", "productId", "storeId") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "ProductPublication" ADD CONSTRAINT "publication_shape" CHECK (
  "expectedEditVersion" > 0 AND "requestHash" ~ '^[a-f0-9]{64}$');

CREATE FUNCTION protect_published_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE rid uuid;
BEGIN
  IF TG_TABLE_NAME = 'ProductRevision' THEN rid := OLD.id;
  ELSE rid := COALESCE(NEW."productRevisionId", OLD."productRevisionId"); END IF;
  -- Child writes serialize with publication's revision lock.
  PERFORM id FROM "ProductRevision" WHERE id=rid FOR UPDATE;
  IF EXISTS (SELECT 1 FROM "ProductPublication" WHERE "revisionId"=rid) THEN
    RAISE EXCEPTION 'Published snapshots are immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_published_revision BEFORE UPDATE OR DELETE ON "ProductRevision" FOR EACH ROW EXECUTE FUNCTION protect_published_revision();
CREATE TRIGGER immutable_published_variants BEFORE INSERT OR UPDATE OR DELETE ON "VariantRevision" FOR EACH ROW EXECUTE FUNCTION protect_published_revision();
CREATE TRIGGER immutable_published_evidence BEFORE INSERT OR UPDATE OR DELETE ON "RevisionSourceRow" FOR EACH ROW EXECUTE FUNCTION protect_published_revision();

CREATE FUNCTION protect_published_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='Variant' THEN
   IF (NEW.id,NEW."storeId",NEW."productId",NEW.sku) IS DISTINCT FROM (OLD.id,OLD."storeId",OLD."productId",OLD.sku)
      AND EXISTS(SELECT 1 FROM "VariantRevision" v JOIN "ProductPublication" p ON p."revisionId"=v."productRevisionId" WHERE v."variantId"=OLD.id) THEN
     RAISE EXCEPTION 'Published variant identity is immutable' USING ERRCODE='23514';
   END IF;
 ELSE
   IF (NEW.id,NEW."storeId",NEW."supplierId") IS DISTINCT FROM (OLD.id,OLD."storeId",OLD."supplierId")
      AND EXISTS(SELECT 1 FROM "ProductPublication" WHERE "productId"=OLD.id) THEN
     RAISE EXCEPTION 'Published product identity is immutable' USING ERRCODE='23514';
   END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER published_variant_identity BEFORE UPDATE ON "Variant" FOR EACH ROW EXECUTE FUNCTION protect_published_identity();
CREATE TRIGGER published_product_identity BEFORE UPDATE ON "Product" FOR EACH ROW EXECUTE FUNCTION protect_published_identity();

CREATE FUNCTION protect_publication_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' OR EXISTS(SELECT 1 FROM "Product" WHERE "publishedRevisionId"=OLD."revisionId") THEN
   RAISE EXCEPTION 'Publication audit is immutable while referenced' USING ERRCODE='23514';
 END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER immutable_publication BEFORE UPDATE OR DELETE ON "ProductPublication" FOR EACH ROW EXECUTE FUNCTION protect_publication_audit();

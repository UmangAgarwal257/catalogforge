-- AlterTable
ALTER TABLE "ProductPublication" ADD COLUMN     "mediaSnapshot" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "translationsSnapshot" JSONB NOT NULL DEFAULT '{}';

-- CreateTable
CREATE TABLE "MediaAsset" (
    "id" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "sha256" VARCHAR(64) NOT NULL,
    "filename" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "previewKey" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "bytes" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RevisionMedia" (
    "id" UUID NOT NULL,
    "revisionId" UUID NOT NULL,
    "assetId" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "variantId" UUID,
    "primary" BOOLEAN NOT NULL DEFAULT false,
    "alt" TEXT NOT NULL,

    CONSTRAINT "RevisionMedia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TranslationDraft" (
    "id" UUID NOT NULL,
    "revisionId" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "locale" VARCHAR(2) NOT NULL,
    "sourceHash" VARCHAR(64) NOT NULL,
    "sourceSnapshot" JSONB NOT NULL,
    "content" JSONB,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "editVersion" INTEGER NOT NULL DEFAULT 1,
    "manualFields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "history" JSONB NOT NULL DEFAULT '[]',
    "runId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMPTZ(3),

    CONSTRAINT "TranslationDraft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MediaAsset_id_storeId_key" ON "MediaAsset"("id", "storeId");

-- CreateIndex
CREATE UNIQUE INDEX "MediaAsset_storeId_sha256_key" ON "MediaAsset"("storeId", "sha256");

-- CreateIndex
CREATE INDEX "RevisionMedia_assetId_idx" ON "RevisionMedia"("assetId");

-- CreateIndex
CREATE UNIQUE INDEX "RevisionMedia_revisionId_assetId_key" ON "RevisionMedia"("revisionId", "assetId");

-- CreateIndex
CREATE UNIQUE INDEX "TranslationDraft_runId_key" ON "TranslationDraft"("runId");

-- CreateIndex
CREATE INDEX "TranslationDraft_storeId_status_idx" ON "TranslationDraft"("storeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "TranslationDraft_revisionId_locale_sourceHash_key" ON "TranslationDraft"("revisionId", "locale", "sourceHash");

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RevisionMedia" ADD CONSTRAINT "RevisionMedia_revisionId_storeId_fkey" FOREIGN KEY ("revisionId", "storeId") REFERENCES "ProductRevision"("id", "storeId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RevisionMedia" ADD CONSTRAINT "RevisionMedia_assetId_storeId_fkey" FOREIGN KEY ("assetId", "storeId") REFERENCES "MediaAsset"("id", "storeId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TranslationDraft" ADD CONSTRAINT "TranslationDraft_revisionId_storeId_fkey" FOREIGN KEY ("revisionId", "storeId") REFERENCES "ProductRevision"("id", "storeId") ON DELETE RESTRICT ON UPDATE RESTRICT;


ALTER TABLE "RevisionMedia" ADD CONSTRAINT "media_variant_membership" FOREIGN KEY ("revisionId","variantId") REFERENCES "VariantRevision"("productRevisionId","variantId") ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE UNIQUE INDEX "one_primary_image_per_scope" ON "RevisionMedia"("revisionId",COALESCE("variantId"::text,'product')) WHERE "primary";
ALTER TABLE "TranslationDraft" ADD CONSTRAINT "translation_locale" CHECK (locale IN ('de','fr'));
ALTER TABLE "TranslationDraft" ADD CONSTRAINT "translation_run_scope" FOREIGN KEY ("runId","storeId") REFERENCES "AIEnrichmentRun"(id,"storeId") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "MediaAsset" ADD CONSTRAINT "image_bounds" CHECK (width>0 AND height>0 AND width::bigint*height<=24000000 AND bytes>0 AND bytes<=10485760 AND format IN ('jpeg','png','webp'));
CREATE FUNCTION guard_revision_media() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_id uuid; new_id uuid;
BEGIN
 IF TG_OP<>'INSERT' THEN old_id:=OLD."revisionId"; END IF;
 IF TG_OP<>'DELETE' THEN new_id:=NEW."revisionId"; END IF;
 PERFORM id FROM "ProductRevision" WHERE id IN(old_id,new_id) ORDER BY id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM "ProductRevision" WHERE id IN(old_id,new_id) AND status IN ('APPROVED','REJECTED')) THEN RAISE EXCEPTION 'Media belongs to a read-only revision' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE TRIGGER revision_media_frozen BEFORE INSERT OR UPDATE OR DELETE ON "RevisionMedia" FOR EACH ROW EXECUTE FUNCTION guard_revision_media();
CREATE FUNCTION guard_media_asset() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'Verified media is immutable' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM "ProductPublication" WHERE "storeId"=OLD."storeId" AND "mediaSnapshot" @> jsonb_build_array(jsonb_build_object('assetId',OLD.id::text))) THEN RAISE EXCEPTION 'Published media cannot be deleted' USING ERRCODE='23514'; END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER verified_media_frozen BEFORE UPDATE OR DELETE ON "MediaAsset" FOR EACH ROW EXECUTE FUNCTION guard_media_asset();
CREATE FUNCTION stale_source_translations() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (OLD.title,OLD."descriptionHtml",OLD.tags,OLD.attributes) IS DISTINCT FROM (NEW.title,NEW."descriptionHtml",NEW.tags,NEW.attributes) THEN
 UPDATE "TranslationDraft" SET status='STALE', "editVersion"="editVersion"+1 WHERE "revisionId"=OLD.id AND status<>'STALE';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER source_translation_staleness AFTER UPDATE ON "ProductRevision" FOR EACH ROW EXECUTE FUNCTION stale_source_translations();

-- AlterTable
ALTER TABLE "Import" ADD COLUMN     "parseRunId" UUID;

-- CreateTable
CREATE TABLE "ParseDispatch" (
    "importId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatchedAt" TIMESTAMPTZ(3),

    CONSTRAINT "ParseDispatch_pkey" PRIMARY KEY ("importId")
);

-- AddForeignKey
ALTER TABLE "ParseDispatch" ADD CONSTRAINT "ParseDispatch_importId_fkey" FOREIGN KEY ("importId") REFERENCES "Import"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- Import registration follows successful original-file storage: its source
-- identity/configuration is finalized at insertion. Processing fields stay mutable.
CREATE FUNCTION public."protect_import_source"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF ROW(NEW."id", NEW."storeId", NEW."supplierId", NEW."originalFilename",
           NEW."storageKey", NEW."fileSha256", NEW."idempotencyKey",
           NEW."parserVersion", NEW."mappingConfig", NEW."createdAt")
       IS DISTINCT FROM
       ROW(OLD."id", OLD."storeId", OLD."supplierId", OLD."originalFilename",
           OLD."storageKey", OLD."fileSha256", OLD."idempotencyKey",
           OLD."parserVersion", OLD."mappingConfig", OLD."createdAt") THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Import source metadata is immutable after registration';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "Import_protect_source"
BEFORE UPDATE ON "Import"
FOR EACH ROW EXECUTE FUNCTION public."protect_import_source"();

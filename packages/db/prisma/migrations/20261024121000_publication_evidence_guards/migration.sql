-- Keep the already-applied publication migration intact; close evidence moves
-- out of a frozen revision as well as moves into one.
CREATE OR REPLACE FUNCTION protect_published_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_id uuid; new_id uuid;
BEGIN
 IF TG_TABLE_NAME='ProductRevision' THEN old_id:=OLD.id; new_id:=NEW.id;
 ELSE old_id:=OLD."productRevisionId"; new_id:=NEW."productRevisionId"; END IF;
 PERFORM id FROM "ProductRevision" WHERE id IN (old_id,new_id) ORDER BY id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM "ProductPublication" WHERE "revisionId" IN (old_id,new_id)) THEN
   RAISE EXCEPTION 'Published snapshots are immutable' USING ERRCODE='23514';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION protect_published_cleaning() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM r.id FROM "ProductRevision" r JOIN "RevisionSourceRow" s ON s."productRevisionId"=r.id WHERE s."cleaningResultId"=OLD.id ORDER BY r.id FOR UPDATE OF r;
 IF EXISTS(SELECT 1 FROM "RevisionSourceRow" s JOIN "ProductPublication" p ON p."revisionId"=s."productRevisionId" WHERE s."cleaningResultId"=OLD.id) THEN
   RAISE EXCEPTION 'Published cleaning provenance is immutable' USING ERRCODE='23514';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER published_cleaning_provenance BEFORE UPDATE OR DELETE ON "RowCleaningResult" FOR EACH ROW EXECUTE FUNCTION protect_published_cleaning();

CREATE OR REPLACE FUNCTION protect_published_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='Variant' THEN
   PERFORM id FROM "Product" WHERE id=OLD."productId" FOR UPDATE;
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

CREATE FUNCTION protect_translation_input() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM "AIEnrichmentRun" WHERE id=NEW."runId" AND "revisionId"=NEW."revisionId" AND "storeId"=NEW."storeId" AND "inputSnapshot"->>'purpose'='translation-v1' AND "inputSnapshot"->>'sourceHash'=NEW."sourceHash" AND "inputSnapshot"->>'locale'=NEW.locale AND "inputSnapshot"->'source'=NEW."sourceSnapshot") THEN
 RAISE EXCEPTION 'Translation must reference its exact frozen source run' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND (OLD.id,OLD."revisionId",OLD."storeId",OLD.locale,OLD."sourceHash",OLD."sourceSnapshot",OLD."runId") IS DISTINCT FROM (NEW.id,NEW."revisionId",NEW."storeId",NEW.locale,NEW."sourceHash",NEW."sourceSnapshot",NEW."runId") THEN
 RAISE EXCEPTION 'Translation source identity is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER translation_input_immutable BEFORE INSERT OR UPDATE ON "TranslationDraft" FOR EACH ROW EXECUTE FUNCTION protect_translation_input();
ALTER TABLE "TranslationDraft" ADD CONSTRAINT "translation_shape" CHECK (status IN ('PENDING','NEEDS_REVIEW','APPROVED','REJECTED','STALE') AND "editVersion">0 AND jsonb_typeof("sourceSnapshot")='object' AND jsonb_typeof(history)='array' AND (content IS NULL OR jsonb_typeof(content)='object'));

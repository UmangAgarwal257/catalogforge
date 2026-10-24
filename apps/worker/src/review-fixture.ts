import { createTerracottaFixture,removeFixture } from "@catalogforge/enrichment/fixture";
import { getDb,disconnectDatabase } from "@catalogforge/db";
import { z } from "zod";
try {
 if(process.env.NODE_ENV==="production"||process.env.VERCEL)throw Error("DEVELOPMENT_ONLY");
 const args=process.argv.slice(2);
 if(args[0]==="--cleanup"){
  const storeId=z.uuid().parse(args[1]);
  const store=await getDb().store.findUniqueOrThrow({where:{id:storeId}});
  if(store.name!=="Disposable AI enrichment fixture")throw Error("NOT_A_REVIEW_FIXTURE");
  await removeFixture(storeId); console.log("Removed only the selected disposable fixture store.");
 } else {
  const fixture=await createTerracottaFixture();
  console.log(JSON.stringify({...fixture,reviewPath:`/products/${fixture.productId}/revisions/${fixture.revisionId}`},null,2));
  console.log(`Retained review fixture for store ${fixture.storeId}. Assign an authenticated account to the store to review it in the application.`);
  console.log(`Generate with REAL Gemini: bun run enrich:one ${fixture.storeId} ${fixture.revisionId}`);
  console.log(`Cleanup: bun run review:fixture --cleanup ${fixture.storeId}`);
 }
} catch { console.error("REVIEW_FIXTURE_FAILED");process.exitCode=1; }
finally { await disconnectDatabase(); }

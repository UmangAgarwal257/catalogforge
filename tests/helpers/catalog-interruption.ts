// Isolated Bun crash fixture: never imported by the application.
import {processCatalogTask} from "@catalogforge/pipeline";
import {testPolicy,testProvider} from "@catalogforge/enrichment/test-stub";
import {disconnectDatabase} from "@catalogforge/db";
if(process.env.NODE_ENV!=="test")throw Error("TEST_ONLY");
const [storeId,importId,checkpoint]=process.argv.slice(2);
const hold=async()=>{console.log("CHECKPOINT");await new Promise(()=>{});};
await processCatalogTask(storeId!,importId!,{policy:testPolicy,provider:testProvider,...(checkpoint==="clean"?{afterCleanBatch:hold}:{afterRunBound:hold})});
await disconnectDatabase();

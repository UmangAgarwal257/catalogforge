import { afterAll, expect, it } from "vitest";
import { getDb, disconnectDatabase } from "@catalogforge/db";
import { createEnrichmentRun, processEnrichmentRun } from "@catalogforge/enrichment";
import { createTerracottaFixture, removeFixture } from "@catalogforge/enrichment/fixture";
import { testPolicy } from "@catalogforge/enrichment/test-stub";
const db=getDb();
afterAll(disconnectDatabase);
it("serializes project quota across stores while another provider call is still in flight",async()=>{
 const first=await createTerracottaFixture(),second=await createTerracottaFixture();
 let release!:()=>void,entered!:()=>void,original:Promise<unknown>|undefined;
 const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);
 try{
  const policy={...testPolicy,provider:"gemini" as const,requestsPerDay:1,primary:{...testPolicy.primary,model:"gemini-3.5-flash-lite"}};
  const a=await createEnrichmentRun(first.storeId,first.revisionId,policy),b=await createEnrichmentRun(second.storeId,second.revisionId,policy);
  let calls=0;
  original=processEnrichmentRun(first.storeId,a.id,{name:"gemini",async generate(){calls++;entered();await gate;return {error:"HTTP_429",retryable:true,retryAfterMs:60000,usageKind:"UNKNOWN"};}});
  await started;
  const competing=await processEnrichmentRun(second.storeId,b.id,{name:"gemini",async generate(){throw Error("Project quota must prevent this call");}});
  expect(calls).toBe(1);expect(competing).toMatchObject({state:"RETRY_WAIT",errorCode:"FREE_TIER_QUOTA"});
  expect(await db.aIEnrichmentAttempt.count({where:{runId:b.id}})).toBe(0);
  expect(await db.aIEnrichmentAttempt.count({where:{runId:a.id}})).toBe(1);
  const before=await db.productRevision.findUniqueOrThrow({where:{id:second.revisionId}});
  await processEnrichmentRun(second.storeId,b.id,{name:"gemini",async generate(){throw Error("Not yet eligible");}});
  expect(await db.productRevision.findUniqueOrThrow({where:{id:second.revisionId}})).toEqual(before);
 }finally{release();await original;await removeFixture(first.storeId);await removeFixture(second.storeId);}
});

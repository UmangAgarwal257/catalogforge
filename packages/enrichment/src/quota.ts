import type { Prisma } from "@catalogforge/db";
import type { Policy } from "./contracts";
// Shared by enrichment and translation; quota is project-wide across stores/processes.
export async function nextGeminiCapacity(tx:Prisma.TransactionClient,policy:Policy):Promise<Date|null>{
 await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('catalogforge-gemini-free-quota-v1'))::text`;
 const now=Date.now();
 const recent=await tx.aIEnrichmentAttempt.findMany({where:{startedAt:{gt:new Date(now-86400000)},run:{policySnapshot:{path:["provider"],equals:"gemini"}}},orderBy:{startedAt:"desc"},take:21});
 let next=(recent[0]?.startedAt.getTime()??0)+60000;
 if(recent.length>=policy.requestsPerDay)next=Math.max(next,recent[policy.requestsPerDay-1]!.startedAt.getTime()+86400000);
 return next>now?new Date(next):null;
}

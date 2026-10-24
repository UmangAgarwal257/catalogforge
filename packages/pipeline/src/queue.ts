import {processTranslation} from "@catalogforge/review/translations";
import { Queue,Worker } from "bullmq";
import { Redis } from "ioredis";
import { getDb } from "@catalogforge/db";
import { z } from "zod";
import { processCatalogTask,type PipelineOptions } from "./service";
export function catalogQueueName(storeId:string){return `catalog-${storeId}-v1`;}
export function catalogProducer(redisUrl:string,storeId:string,queueName=catalogQueueName(storeId)){
 const connection=new Redis(redisUrl,{enableOfflineQueue:false,maxRetriesPerRequest:1,connectTimeout:3000,commandTimeout:3000});connection.on("error",()=>{});
 const queue=new Queue(queueName,{connection});queue.on("error",()=>{});return {queue,connection};
}
export async function dispatchCatalog(queue:Queue,storeId:string){
 if(queue.opts.connection instanceof Redis&&queue.opts.connection.status!=="ready")throw Error("CATALOG_REDIS_UNAVAILABLE");
 // Translation run state is authoritative; this is the existing reconciler/queue,
 // not an independent lifecycle or sleeping job.
 const translations=await getDb().translationDraft.findMany({where:{storeId,status:"PENDING"},select:{id:true,runId:true},take:2000});
 const now=new Date();
 const due=await getDb().aIEnrichmentRun.findMany({where:{id:{in:translations.map(t=>t.runId)},state:{in:["PENDING","RUNNING","RETRY_WAIT"]},AND:[{OR:[{leaseUntil:null},{leaseUntil:{lte:now}}]},{OR:[{nextAttemptAt:null},{nextAttemptAt:{lte:now}}]}]},take:100});
 for(const run of due){const translation=translations.find(t=>t.runId===run.id)!;const jobId=`translation-${translation.id}`;const job=await queue.getJob(jobId);const state=await job?.getState();if(state==="completed"||state==="failed")await job?.remove();if(!job||state==="completed"||state==="failed")await queue.add("translation",{translationId:translation.id,storeId},{jobId,attempts:1,removeOnComplete:true,removeOnFail:{age:86400}});}
 let cursor:string|undefined;
 for(;;){const now=new Date();const tasks=await getDb().catalogTask.findMany({where:{storeId,state:{in:["PENDING","RUNNING","WAITING"]},AND:[{OR:[{leaseUntil:null},{leaseUntil:{lte:now}}]},{OR:[{nextAttemptAt:null},{nextAttemptAt:{lte:now}}]}]},orderBy:{importId:"asc"},take:100,...(cursor?{cursor:{importId:cursor},skip:1}:{})});if(!tasks.length)return;
 for(const task of tasks){const job=await queue.getJob(task.importId);const state=await job?.getState();if(state==="completed"||state==="failed")await job?.remove();if(!job||state==="completed"||state==="failed")await queue.add("continue",{importId:task.importId,storeId},{jobId:task.importId,attempts:1,removeOnComplete:true,removeOnFail:{age:86400}});}
 cursor=tasks.at(-1)!.importId;
 }
}
export function catalogConsumer(redisUrl:string,storeId:string,queueName=catalogQueueName(storeId),options:PipelineOptions={}){
 if((options.provider||options.policy)&&process.env.NODE_ENV!=="test")throw Error("TEST_PROVIDER_ONLY");
 const connection=new Redis(redisUrl,{maxRetriesPerRequest:null,connectTimeout:5000,socketTimeout:15000});connection.on("error",()=>{});
 const worker=new Worker(queueName,async job=>{if(job.name==="translation"){const input=z.object({storeId:z.uuid(),translationId:z.uuid()}).parse(job.data);if(input.storeId!==storeId)throw Error("CATALOG_SCOPE");await processTranslation(storeId,input.translationId);return;}const input=z.object({storeId:z.uuid(),importId:z.uuid()}).parse(job.data);if(input.storeId!==storeId)throw Error("CATALOG_SCOPE");await processCatalogTask(storeId,input.importId,options);},{connection,concurrency:1,lockDuration:30000});worker.on("error",()=>{});
 return {worker,connection,async isAvailable(){
  if(!worker.isRunning()||worker.isPaused()||worker.closing||connection.status!=="ready")return false;
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([(async()=>{const blocking=await worker.getBackend().blockingClient;if(blocking?.status!=="ready")return false;await connection.ping();return true;})(),new Promise<false>(r=>{timer=setTimeout(()=>r(false),1000);})]);}catch{return false;}finally{clearTimeout(timer);}
 }};
}

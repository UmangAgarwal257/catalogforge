import { getDb } from "@catalogforge/db";
import { z } from "zod";
import { IngestionError } from "@catalogforge/ingestion/contracts";
import { createOriginalStorage, type OriginalStorage } from "@catalogforge/ingestion/storage";
import { publicAsset,uploadImage,mediaLibrary,assignImage,IMAGE_LIMITS } from "./media";
import { requestTranslation,mutateTranslation,translationsFor,localeSchema } from "./translations";
import { createUpdate } from "./updates";
import { ReviewError } from "./contracts";
import { storefrontStoreId } from "./catalog";
const headers={"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"};
async function bounded(request:Request,max:number){
 if(Number(request.headers.get("content-length"))>max)throw new ReviewError("BODY_LIMIT",413,"Request exceeds the upload limit.");
 if(!request.body)throw new ReviewError("BODY_REQUIRED",400,"Provide a request body.");
 const reader=request.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;
 try{for(;;){const r=await reader.read();if(r.done)break;bytes+=r.value.length;if(bytes>max){await reader.cancel();throw new ReviewError("BODY_LIMIT",413,"Request exceeds the upload limit.");}chunks.push(r.value);}}finally{reader.releaseLock();}
 return Buffer.concat(chunks);
}
export async function extrasEndpoint(request:Request,resource:"media"|"revision-media"|"translations"|"translation"|"update",id?:string,scopedStoreId?:string,storageOverride?:OriginalStorage){
 try{
  if(!scopedStoreId)throw new IngestionError("STORE_SCOPE_REQUIRED","Authenticated store scope is required.",401);const storeId=scopedStoreId;if(id)z.uuid().parse(id);
  if(resource==="media"){
   if(request.method==="GET"){
    const q=new URL(request.url).searchParams,page=z.coerce.number().int().min(1).max(1000).parse(q.get("page")??1),revisionId=q.get("revisionId")??undefined;if(revisionId)z.uuid().parse(revisionId);
    return Response.json(await mediaLibrary(storeId,page,revisionId),{headers});
   }
   if(request.method!=="POST")return new Response(null,{status:405,headers});
   const bytes=await bounded(request,IMAGE_LIMITS.bytes+65536);
   const form=await new Response(bytes,{headers:{"Content-Type":request.headers.get("content-type")??""}}).formData();
   const files=form.getAll("file"),file=files[0];if(files.length!==1||!file||typeof file==="string")throw new ReviewError("ONE_IMAGE",400,"Upload one image per request.");
   return Response.json(await uploadImage(storeId,storageOverride??createOriginalStorage(),file.name,new Uint8Array(await file.arrayBuffer())),{headers});
  }
  if(!id)throw new ReviewError("NOT_FOUND",404,"Not found.");
  if(request.method==="GET"){
   if(resource==="translations")return Response.json({items:await translationsFor(storeId,id)},{headers});
   if(resource==="revision-media"){
    const r=await getDb().productRevision.findFirst({where:{id,storeId},select:{id:true}});if(!r)throw new ReviewError("NOT_FOUND",404,"Not found.");
    const rows=await getDb().revisionMedia.findMany({where:{revisionId:id,storeId},include:{asset:true},orderBy:[{primary:"desc"},{id:"asc"}],take:2000});
    return Response.json({items:rows.map(row=>({...publicAsset(row.asset),variantId:row.variantId,primary:row.primary,alt:row.alt}))},{headers});
   }
   return new Response(null,{status:405,headers});
  }
  if(request.method!=="POST")return new Response(null,{status:405,headers});
  const body=JSON.parse((await bounded(request,128*1024)).toString("utf8"));
  if(resource==="revision-media")return Response.json(await assignImage(storeId,id,body),{headers});
  if(resource==="translation")return Response.json(await mutateTranslation(storeId,id,body),{headers});
  const b=z.object({requestId:z.uuid(),expectedEditVersion:z.number().int().positive(),locale:localeSchema.optional()}).strict().parse(body);
  if(resource==="update")return Response.json(await createUpdate(storeId,id,b.requestId,b.expectedEditVersion),{headers});
  if(!b.locale)throw new ReviewError("LOCALE_REQUIRED",422,"Choose German or French.");
  return Response.json(await requestTranslation(storeId,id,b.locale,b.expectedEditVersion,undefined,b.requestId),{status:202,headers});
 }catch(error){
  const status=error instanceof ReviewError?error.status:error instanceof IngestionError?error.httpStatus:error instanceof z.ZodError?422:503;
  const message=error instanceof ReviewError||error instanceof IngestionError?error.message:error instanceof z.ZodError?"Check the request fields.":"Service unavailable. Check local storage and Gemini free-tier configuration, then retry the same action.";
  return Response.json({error:{message}},{status,headers});
 }
}
export async function mediaFile(request:Request,id:string,authorizedStoreId?:string,storageOverride?:OriginalStorage){
 try{
  z.uuid().parse(id);const db=getDb(),scope=new URL(request.url).searchParams.get("scope");
  let storeId:string;
  if(scope==="review"){
   if(!authorizedStoreId)return new Response(null,{status:401});
   storeId=authorizedStoreId;
  }else{
   storeId=storefrontStoreId();
   const published=await db.productPublication.findFirst({where:{storeId,mediaSnapshot:{array_contains:[{assetId:id}]},revision:{publishedFor:{some:{storeId,archivedAt:null}}}},select:{id:true}});
   if(!published)return new Response(null,{status:404});
  }
  const asset=await db.mediaAsset.findFirst({where:{id,storeId}});if(!asset)return new Response(null,{status:404});
  const storage=storageOverride??createOriginalStorage();
  const stream=await storage.open(asset.previewKey),parts:Buffer[]=[];let size=0;
  for await(const chunk of stream){size+=chunk.length;if(size>IMAGE_LIMITS.bytes)throw Error("bounds");parts.push(Buffer.from(chunk));}
  return new Response(Buffer.concat(parts),{headers:{"Content-Type":"image/webp","Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff","Content-Security-Policy":"default-src 'none'; sandbox"}});
 }catch{return new Response(null,{status:404});}
}

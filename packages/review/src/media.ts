import sharp from "sharp";
import { getDb, findVariantBySku } from "@catalogforge/db";
import { LocalOriginalStorage, sha256 } from "@catalogforge/ingestion/storage";
import { z } from "zod";
import { ReviewError } from "./contracts";
import { hash, json } from "./validation";

export const IMAGE_LIMITS = { bytes: 10 * 1024 * 1024, pixels: 24000000, assets: 2000, preview: 1200 } as const;
// Bound libvips threads/cache. The HTTP uploader sends one image at a time.
sharp.cache({ memory: 32, files: 0, items: 32 });
sharp.concurrency(1);
export async function verifyImage(bytes: Uint8Array) {
  if (!bytes.length || bytes.length > IMAGE_LIMITS.bytes) throw new ReviewError("IMAGE_SIZE", 413, "Each photo must be between 1 byte and 10 MiB.");
  const b = Buffer.from(bytes);
  const signature = b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff ? "jpeg" : b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? "png" : b.toString("ascii",0,4)==="RIFF" && b.toString("ascii",8,12)==="WEBP" ? "webp" : null;
  if (!signature) throw new ReviewError("IMAGE_FORMAT", 422, "Use a real JPEG, PNG or WebP image. SVG, GIF and other payloads are not accepted.");
  try {
    const image = sharp(b, { limitInputPixels: IMAGE_LIMITS.pixels, failOn: "warning", animated: false });
    const metadata = await image.metadata();
    if (metadata.format !== signature || !metadata.width || !metadata.height || (metadata.pages ?? 1) !== 1 || metadata.width * metadata.height > IMAGE_LIMITS.pixels) throw Error("bounds");
    const preview = await image.rotate().resize(IMAGE_LIMITS.preview,IMAGE_LIMITS.preview,{fit:"inside",withoutEnlargement:true}).webp({quality:82}).toBuffer();
    return {format:signature,width:metadata.width,height:metadata.height,preview};
  } catch { throw new ReviewError("INVALID_IMAGE",422,"Photo is malformed, animated, truncated, or exceeds 24 megapixels."); }
}
export function safeFilename(name:string) { return name.replaceAll("\\","/").split("/").at(-1)!.replace(/[\u0000-\u001f\u007f]/g,"").slice(0,200)||"photo"; }
export async function uploadImage(storeId:string, storage:LocalOriginalStorage, filename:string, bytes:Uint8Array) {
  const fingerprint=sha256(bytes);
  const existing=await getDb().mediaAsset.findUnique({where:{storeId_sha256:{storeId,sha256:fingerprint}}});
  if(existing)return {asset:publicAsset(existing),reused:true};
  const verified=await verifyImage(bytes);
  const storageKey=await storage.save(bytes);let previewKey:string|undefined;
  try {
    previewKey=await storage.save(verified.preview);
    const asset=await getDb().$transaction(async tx=>{
      await tx.$queryRaw`SELECT id FROM "Store" WHERE id=${storeId}::uuid FOR UPDATE`;
      const duplicate=await tx.mediaAsset.findUnique({where:{storeId_sha256:{storeId,sha256:fingerprint}}});
      if(duplicate)return duplicate;
      if(await tx.mediaAsset.count({where:{storeId}})>=IMAGE_LIMITS.assets)throw new ReviewError("IMAGE_QUOTA",422,"This development store has reached its 2,000-photo limit.");
      return tx.mediaAsset.create({data:{storeId,sha256:fingerprint,filename:safeFilename(filename),storageKey,previewKey:previewKey!,format:verified.format,width:verified.width,height:verified.height,bytes:bytes.length}});
    });
    if(asset.storageKey!==storageKey){await storage.remove(storageKey);await storage.remove(previewKey);}
    return {asset:publicAsset(asset),reused:asset.storageKey!==storageKey};
  }catch(error){await storage.remove(storageKey).catch(()=>{});if(previewKey)await storage.remove(previewKey).catch(()=>{});throw error;}
}
export const publicAsset=(a:{id:string;filename:string;width:number;height:number;bytes:number;sha256:string})=>({id:a.id,filename:a.filename,width:a.width,height:a.height,bytes:a.bytes,sha256:a.sha256,url:`/api/media/${a.id}?scope=review`});
export async function mediaLibrary(storeId:string,page:number,revisionId?:string) {
  const assets=await getDb().mediaAsset.findMany({where:{storeId},orderBy:{createdAt:"desc"},skip:(page-1)*24,take:25,include:{_count:{select:{assignments:true}}}});
  const items=[];
  for(const asset of assets.slice(0,24)){
    // Exact filename stem or explicit SKU__suffix convention only; no title/fuzzy matching.
    const stem=asset.filename.replace(/\.[^.]+$/,"").split("__")[0]!;
    const variant=await findVariantBySku(storeId,stem);
    const eligible=variant&&!variant.archivedAt&&(!revisionId||await getDb().variantRevision.findUnique({where:{productRevisionId_variantId:{productRevisionId:revisionId,variantId:variant.id}}}));
    items.push({...publicAsset(asset),assigned:asset._count.assignments,suggestedVariantId:eligible?variant.id:null,suggestedProductId:eligible?variant.productId:null});
  }
  return {items,hasMore:assets.length>24};
}
export const mediaMutation=z.object({requestId:z.uuid(),expectedEditVersion:z.number().int().positive(),assetId:z.uuid(),action:z.enum(["ASSIGN","REMOVE"]),variantId:z.uuid().nullable().default(null),primary:z.boolean().default(false),alt:z.string().trim().min(1).max(300)}).strict();
export async function assignImage(storeId:string,revisionId:string,input:unknown){
 const b=mediaMutation.parse(input),requestHash=hash({action:"MEDIA",body:b});
 return getDb().$transaction(async tx=>{
  const r=await tx.productRevision.findFirst({where:{id:revisionId,storeId}});if(!r)throw new ReviewError("NOT_FOUND",404,"Proposal not found.");
  await tx.$queryRaw`SELECT id FROM "Product" WHERE id=${r.productId}::uuid FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM "ProductRevision" WHERE id=${revisionId}::uuid FOR UPDATE`;
  const replay=await tx.productReviewEvent.findUnique({where:{revisionId_requestId:{revisionId,requestId:b.requestId}}});
  if(replay){if(replay.requestHash!==requestHash)throw new ReviewError("REQUEST_CONFLICT",409,"Request already used.");return {reused:true};}
  const fresh=await tx.productRevision.findUniqueOrThrow({where:{id:revisionId}});
  if(fresh.editVersion!==b.expectedEditVersion)throw new ReviewError("STALE_EDIT",409,"Reload the saved revision before assigning photos.");
  if(!["DRAFT","NEEDS_REVIEW"].includes(fresh.status))throw new ReviewError("READ_ONLY",409,"Create an update before changing approved media.");
  if(!await tx.mediaAsset.findFirst({where:{id:b.assetId,storeId}}))throw new ReviewError("NOT_FOUND",404,"Photo not found.");
  if(b.variantId&&!await tx.variantRevision.findUnique({where:{productRevisionId_variantId:{productRevisionId:revisionId,variantId:b.variantId}}}))throw new ReviewError("VARIANT_SCOPE",422,"Choose a variant of this proposal.");
  if(b.action==="REMOVE")await tx.revisionMedia.deleteMany({where:{revisionId,assetId:b.assetId,storeId}});
  else {
   if(b.primary)await tx.revisionMedia.updateMany({where:{revisionId,variantId:b.variantId},data:{primary:false}});
   await tx.revisionMedia.upsert({where:{revisionId_assetId:{revisionId,assetId:b.assetId}},create:{revisionId,storeId,assetId:b.assetId,variantId:b.variantId,primary:b.primary,alt:b.alt},update:{variantId:b.variantId,primary:b.primary,alt:b.alt}});
  }
  await tx.productRevision.update({where:{id:revisionId},data:{editVersion:{increment:1}}});
  await tx.productReviewEvent.create({data:{revisionId,storeId,requestId:b.requestId,requestHash,action:"EDIT",beforeVersion:fresh.editVersion,afterVersion:fresh.editVersion+1,changes:json({media:b}),decisions:[]}});
  return {reused:false};
 });
}

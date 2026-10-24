import { variantPatchSchema } from "@catalogforge/review/contracts";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import Papa from "papaparse";
import { getDb, disconnectDatabase } from "@catalogforge/db";
import { removeFixture } from "@catalogforge/enrichment/fixture";
import { testPolicy, testProvider } from "@catalogforge/enrichment/test-stub";
import { importEndpoint } from "@catalogforge/ingestion/http";
import { processParseImport } from "@catalogforge/ingestion/processing";
import { LocalOriginalStorage } from "@catalogforge/ingestion/storage";
import { processCatalogTask } from "@catalogforge/pipeline";
import { SUPPLIER_PROFILES } from "@catalogforge/shared/catalog";
import { activeIssues } from "@catalogforge/review/validation";
import { mutateReview, loadReview } from "@catalogforge/review";
import { publishRevision } from "@catalogforge/review/publication";
import { publishedProduct, listPublished } from "@catalogforge/review/catalog";
import { captureExport, catalogExport, exportEndpoint } from "@catalogforge/review/export";
import { reviewEndpoint } from "@catalogforge/review/http";
const db = getDb(); let storeId: string, supplierId: string, directory: string;
const body = (expectedEditVersion: number) => ({ requestId: crypto.randomUUID(), expectedEditVersion });
beforeEach(async () => {storeId=(await db.store.create({data:{name:"Publication isolated"}})).id;supplierId=(await db.supplier.create({data:{storeId,name:"Supplier"}})).id;directory=await mkdtemp(join(tmpdir(),"publication-"));});
afterEach(async () => {vi.unstubAllEnvs();await removeFixture(storeId);await rm(directory,{recursive:true,force:true});});afterAll(disconnectDatabase);
async function ingest(profile=0, price="12,50") {
 const headers=SUPPLIER_PROFILES[profile]!.headers;
 const rows=[["000123", "FAMILY-MUG", "Ceramic mug", "<p>Hand wash only. Not microwave safe.</p>", profile?"12.50":price,profile?"GBP":"EUR",profile?"250":"0,25","350 ml","Blue","Ceramic"],
 ["000124","FAMILY-MUG","Ceramic mug","<p>Hand wash only. Not microwave safe.</p>",profile?"15.00":"15,00",profile?"GBP":"EUR",profile?"300":"0,30","450 ml","Blue","Ceramic"]];
 let bytes:Uint8Array;if(profile){const book=new ExcelJS.Workbook();const sheet=book.addWorksheet("Goods");sheet.addRow(headers);rows.forEach(r=>sheet.addRow(r));bytes=new Uint8Array(await book.xlsx.writeBuffer());}else bytes=Buffer.from([headers,...rows].map(r=>r.join(";")).join("\n"));
 const form=new FormData();form.set("supplierId",supplierId);form.set("idempotencyKey",crypto.randomUUID());form.set("profileId",SUPPLIER_PROFILES[profile]!.id);form.set("file",new File([new Uint8Array(bytes)],profile?"goods.xlsx":"goods.csv"));
 const response=await importEndpoint(new Request("https://catalog.example/api/imports",{method:"POST",body:form}),undefined,"imports",storeId,new LocalOriginalStorage(directory));expect(response.status).toBe(202);const {importId}=await response.json() as {importId:string};vi.stubEnv("NODE_ENV","test");
 await processParseImport(importId,storeId,new LocalOriginalStorage(directory));await processCatalogTask(storeId,importId,{provider:testProvider,policy:testPolicy});
 return db.productRevision.findFirstOrThrow({where:{storeId,originImportId:importId}});
}
async function approve(id:string) {
 const d=await loadReview(storeId,id);
 await mutateReview(storeId,id,"EDIT",{...body(d.revision.editVersion),fields:{categoryKey:"Kitchen & Dining > Drinkware"}});
 const edited=await loadReview(storeId,id);const suggestions=activeIssues(edited).filter(i=>i.kind!=="VALUE");
 if(suggestions.length)await mutateReview(storeId,id,"EDIT",{...body(edited.revision.editVersion),decisions:suggestions.map(i=>({issueId:i.id,disposition:i.kind==="FACT"?"RESOLVE":i.field==="categoryKey"&&i.value===edited.revision.categoryKey?"ADOPT_CATEGORY":"DISCARD",reason:i.kind==="FACT"?"Sizes remain variant-specific options; no shared product size is claimed.":"Merchant reviewed and declined unsupported generated wording.",evidenceRefs:i.kind==="FACT"?edited.sources.map(s=>({sourceRowId:s.sourceRowId,columnIndex:7})):[]}))});
 const saved=await loadReview(storeId,id);expect(activeIssues(saved)).toEqual([]);
 await mutateReview(storeId,id,"APPROVE",body(saved.revision.editVersion));return loadReview(storeId,id);
}
async function exported(format:"csv"|"json"|"shopify", currency?:string, ids?:string[]) {const captured=await captureExport(storeId,format,currency);let output="";for await(const text of catalogExport(storeId,ids??captured.revisionIds,format,captured.currency))output+=text;return output;}
it.each([0,1])("uploads profile %s, keeps approval private, publishes and exports exactly both variants",async profile=>{
 const r=await ingest(profile);expect(await publishedProduct(storeId,r.productId)).toBeNull();const approved=await approve(r.id);expect(approved.revision.product.publishedRevisionId).toBeNull();expect((await listPublished(storeId)).products).toEqual([]);
 const input=body(approved.revision.editVersion);const first=await publishRevision(storeId,r.id,input);expect((await publishRevision(storeId,r.id,input)).publication.id).toBe(first.publication.id);
 const product=await publishedProduct(storeId,r.productId);expect(product).toMatchObject({title:"Ceramic mug",attributes:{material:"Ceramic"}});expect(product!.variants.map(v=>v.sku).sort()).toEqual(["000123","000124"]);
 const json=JSON.parse(await exported("json"));expect(json).toHaveLength(1);expect(json[0].variants).toHaveLength(2);expect(json[0].variants.map((v:{priceMinor:string})=>v.priceMinor).sort()).toEqual(["1250","1500"]);
 const csv=Papa.parse<Record<string,string>>(await exported("csv"),{header:true,skipEmptyLines:true});expect(csv.errors).toEqual([]);expect(csv.data.map(v=>v.sku).sort()).toEqual(["000123","000124"]);expect(csv.data[0]!.description_html).toContain("Not microwave safe");
 const shop=Papa.parse<Record<string,string>>(await exported("shopify"),{header:true,skipEmptyLines:true});expect(shop.data).toHaveLength(2);expect(shop.data.map(v=>v["Variant SKU"]).sort()).toEqual(["000123","000124"]);expect(shop.data[0]!["Body (HTML)"]).toContain("Ceramic");expect(shop.data.every(v=>v.Status==="draft"&&v.Published==="false")).toBe(true);
 expect((await listPublished(crypto.randomUUID())).products).toHaveLength(0);expect(await publishedProduct(crypto.randomUUID(),r.productId)).toBeNull();
});
it("keeps draft edits invisible and preserves historical snapshots when a successor publishes",async()=>{
 const r=await ingest();const approved=await approve(r.id);await publishRevision(storeId,r.id,body(approved.revision.editVersion));const first=await publishedProduct(storeId,r.productId);const captured=await captureExport(storeId,"json");
 const successor=await ingest(0,"19,99");await mutateReview(storeId,successor.id,"EDIT",{...body(successor.editVersion),fields:{title:"New merchant title"}});expect(await publishedProduct(storeId,r.productId)).toEqual(first);
 const next=await approve(successor.id);await publishRevision(storeId,successor.id,body(next.revision.editVersion));expect((await publishedProduct(storeId,r.productId))!.title).toBe("New merchant title");
 const historical=await db.productRevision.findUniqueOrThrow({where:{id:r.id}});expect(historical.title).toBe("Ceramic mug");expect(JSON.parse(await exported("json",undefined,captured.revisionIds))[0].title).toBe("Ceramic mug");expect(await db.productPublication.count({where:{storeId}})).toBe(2);
 await expect(db.productRevision.update({where:{id:r.id},data:{title:"Corrupt"}})).rejects.toThrow(/immutable/);
 await expect(db.variantRevision.updateMany({where:{productRevisionId:r.id},data:{priceMinor:1n}})).rejects.toThrow(/immutable/);
 const link=await db.revisionSourceRow.findFirstOrThrow({where:{productRevisionId:r.id}});await expect(db.revisionSourceRow.delete({where:{sourceRowId_productRevisionId:{sourceRowId:link.sourceRowId,productRevisionId:r.id}}})).rejects.toThrow(/immutable/);
 await expect(db.variant.updateMany({where:{productId:r.productId},data:{sku:"renamed"}})).rejects.toThrow(/immutable/);
});
it("rejects unapproved, rejected, stale, incomplete and cross-store publication",async()=>{
 const r=await ingest();await expect(publishRevision(storeId,r.id,body(r.editVersion))).rejects.toMatchObject({status:422});await expect(publishRevision(crypto.randomUUID(),r.id,body(r.editVersion))).rejects.toMatchObject({status:404});
 const a=await approve(r.id);await expect(publishRevision(storeId,r.id,body(1))).rejects.toMatchObject({status:409});
 await db.variantRevision.updateMany({where:{productRevisionId:r.id},data:{priceMinor:null}});await expect(publishRevision(storeId,r.id,body(a.revision.editVersion))).rejects.toMatchObject({status:422});
 await db.productRevision.update({where:{id:r.id},data:{status:"REJECTED"}});await expect(publishRevision(storeId,r.id,body(a.revision.editVersion))).rejects.toMatchObject({status:422});expect(await db.productPublication.count({where:{storeId}})).toBe(0);
});
it("serializes concurrent publishes and rejects changed request IDs without duplicate audits",async()=>{
 const r=await ingest();const a=await approve(r.id);const input=body(a.revision.editVersion);
 const results=await Promise.all([publishRevision(storeId,r.id,input),publishRevision(storeId,r.id,input)]);expect(results.map(x=>x.publication.id)).toEqual([results[0]!.publication.id,results[0]!.publication.id]);expect(await db.productPublication.count({where:{storeId}})).toBe(1);
 await expect(publishRevision(storeId,r.id,{...input,expectedEditVersion:99})).rejects.toMatchObject({status:409});
});
it("requires a server-derived store scope for publication and export handlers",async()=>{
 const r=await ingest();const a=await approve(r.id);const req=()=>new Request(`https://catalog.example/api/product-revisions/${r.id}/publish`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body(a.revision.editVersion))});
 expect((await reviewEndpoint(req(),r.id,"publish")).status).toBe(401);expect((await reviewEndpoint(req(),r.id,"publish",storeId)).status).toBe(200);
 expect((await exportEndpoint(new Request("https://catalog.example/api/catalog/export?format=json"))).status).toBe(401);expect((await exportEndpoint(new Request("https://catalog.example/api/catalog/export?format=json"),storeId)).status).toBe(200);
});

it("prevents moving evidence out of a published revision and modifying its cleaning provenance",async()=>{
 const r=await ingest();const a=await approve(r.id);await publishRevision(storeId,r.id,body(a.revision.editVersion));const successor=await ingest(0,"19,99");
 const link=await db.revisionSourceRow.findFirstOrThrow({where:{productRevisionId:r.id}});
 await db.revisionSourceRow.deleteMany({where:{sourceRowId:link.sourceRowId,productRevisionId:successor.id}});
 await expect(db.revisionSourceRow.update({where:{sourceRowId_productRevisionId:{sourceRowId:link.sourceRowId,productRevisionId:r.id}},data:{productRevisionId:successor.id}})).rejects.toThrow(/immutable/);
 await expect(db.rowCleaningResult.update({where:{id:link.cleaningResultId!},data:{normalized:{corrupted:true}}})).rejects.toThrow(/immutable/);
});

it("rejects a stale approved baseline after another approved successor wins",async()=>{
 const r=await ingest();const a=await approve(r.id);await publishRevision(storeId,r.id,body(a.revision.editVersion));
 const second=await ingest(0,"17,00");const a2=await approve(second.id);const third=await db.productRevision.create({data:{productId:r.productId,storeId,status:"APPROVED",approvedAt:new Date(),basePublishedRevisionId:r.id,title:"Concurrent approved branch",descriptionHtml:a2.revision.descriptionHtml,categoryKey:a2.revision.categoryKey}});
 await db.variantRevision.createMany({data:a2.revision.variants.map(v=>({productRevisionId:third.id,variantId:v.variantId,storeId,productId:r.productId,options:variantPatchSchema.parse({variantId:v.variantId,options:v.options}).options!,priceMinor:v.priceMinor,currency:v.currency,weightGrams:v.weightGrams}))});
 const links=await db.revisionSourceRow.findMany({where:{productRevisionId:second.id}});await db.revisionSourceRow.createMany({data:links.map(l=>({...l,productRevisionId:third.id}))});
 expect(activeIssues(await loadReview(storeId,third.id))).toEqual([]);
 const a3={revision:third};
 await publishRevision(storeId,second.id,body(a2.revision.editVersion));await expect(publishRevision(storeId,third.id,body(a3.revision.editVersion))).rejects.toMatchObject({status:422,issues:expect.arrayContaining([expect.objectContaining({code:"STALE_BASELINE"})])});
 expect((await publishedProduct(storeId,r.productId))!.revisionId).toBe(second.id);
});
it("streams bounded export snapshots and rejects unsupported Shopify options before downloading",async()=>{
 const r=await ingest();const a=await approve(r.id);await db.variantRevision.updateMany({where:{productRevisionId:r.id},data:{options:{one:"1",two:"2",three:"3",four:"4"}}});
 // The two variants still need distinct combinations to pass publication.
 const v=await db.variantRevision.findFirstOrThrow({where:{productRevisionId:r.id}});await db.variantRevision.update({where:{productRevisionId_variantId:{productRevisionId:r.id,variantId:v.variantId}},data:{options:{one:"5",two:"2",three:"3",four:"4"}}});await publishRevision(storeId,r.id,body(a.revision.editVersion));
 await expect(captureExport(storeId,"shopify")).rejects.toMatchObject({status:422,code:"SHOPIFY_OPTIONS"});expect(JSON.parse(await exported("json"))[0].variants).toHaveLength(2);
 const res=await exportEndpoint(new Request("https://catalog.example/api/catalog/export?format=csv"),storeId);expect(res.status).toBe(200);expect(res.headers.get("cache-control")).toBe("no-store");expect(res.headers.get("content-disposition")).toContain("attachment");expect(Papa.parse(await res.text(),{header:true,skipEmptyLines:true}).data).toHaveLength(2);
});

it("rejects publication when linked source ingestion is no longer complete",async()=>{
 const r=await ingest();const a=await approve(r.id);await db.import.update({where:{id:r.originImportId!},data:{status:"FAILED"}});await expect(publishRevision(storeId,r.id,body(a.revision.editVersion))).rejects.toMatchObject({status:422,code:"SOURCE_IMPORT_UNAVAILABLE"});expect(await publishedProduct(storeId,r.productId)).toBeNull();
});

it("neutralizes formulas in CSV while JSON retains exact merchant text and BIGINT money",async()=>{
 const r=await ingest();await mutateReview(storeId,r.id,"EDIT",{...body(r.editVersion),fields:{title:"=SUM(1,2)"}});const a=await approve(r.id);const v=a.revision.variants[0]!;await db.variantRevision.update({where:{productRevisionId_variantId:{productRevisionId:r.id,variantId:v.variantId}},data:{priceMinor:9223372036854775807n}});await publishRevision(storeId,r.id,body(a.revision.editVersion));
 const csv=Papa.parse<Record<string,string>>(await exported("csv"),{header:true,skipEmptyLines:true});expect(csv.data[0]!.title).toBe("'=SUM(1,2)");const json=JSON.parse(await exported("json"));expect(json[0].title).toBe("=SUM(1,2)");expect(json[0].variants.find((x:{variantId:string})=>x.variantId===v.variantId)).toMatchObject({priceMinor:"9223372036854775807",price:"92233720368547758.07"});
});
it("rejects unsafe or restriction-losing HTML even on a tampered approved revision",async()=>{
 const r=await ingest();const a=await approve(r.id);await db.productRevision.update({where:{id:r.id},data:{descriptionHtml:"<script>alert(1)</script><p>Safe.</p>"}});await expect(publishRevision(storeId,r.id,body(a.revision.editVersion))).rejects.toMatchObject({status:422,issues:expect.arrayContaining([expect.objectContaining({code:"UNSAFE_HTML"})])});expect(await publishedProduct(storeId,r.productId)).toBeNull();
});

it("excludes a genuinely published second store from public reads and export capture",async()=>{
 const r=await ingest();const a=await approve(r.id);await publishRevision(storeId,r.id,body(a.revision.editVersion));const firstStore=storeId,firstSupplier=supplierId;
 const secondStore=(await db.store.create({data:{name:"Other published store"}})).id;
 try {storeId=secondStore;supplierId=(await db.supplier.create({data:{storeId,name:"Other supplier"}})).id;const other=await ingest();const approved=await approve(other.id);await publishRevision(storeId,other.id,body(approved.revision.editVersion));
 expect(await publishedProduct(firstStore,other.productId)).toBeNull();expect((await listPublished(firstStore)).products.map(p=>p.id)).toEqual([r.productId]);expect((await captureExport(firstStore,"json")).revisionIds).toEqual([r.id]);
 } finally {storeId=firstStore;supplierId=firstSupplier;await removeFixture(secondStore);}
});

import { createHash } from "node:crypto";
import { catalogConfigJson, profileSnapshotSchema, type ProfileSnapshot } from "@catalogforge/shared/catalog";
import { cleaningConfigSchema } from "@catalogforge/cleaning/contracts";
import { groupingConfigSchema } from "@catalogforge/grouping/contracts";
export function frozenProfile(input:unknown):ProfileSnapshot {
 const snapshot=profileSnapshotSchema.parse(input);
 const {configHash,...data}=snapshot;
 if(createHash("sha256").update(catalogConfigJson(data)).digest("hex")!==configHash)throw Error("PROFILE_HASH_MISMATCH");
 return snapshot;
}
export function cleaningConfig(snapshot:ProfileSnapshot,storeId:string,supplierId:string,sheetIndex:number){
 const names=["sku","attributes.familyId","title","description","price","currency","weight","attributes.size","attributes.colour","attributes.material"];
 return cleaningConfigSchema.parse({storeId,supplierId,sheetIndex,columns:Object.fromEntries(names.map((name,i)=>[name,[{columnIndex:i,expectedHeader:snapshot.profile.headers[i]}]])),
 numberFormat:{decimal:snapshot.profile.decimal,grouping:snapshot.profile.grouping},defaultCurrency:null,symbolCurrencies:{"€":"EUR","£":"GBP","$":"USD"},weightUnit:snapshot.profile.weightUnit,
 dimensionUnits:{},unitAliases:{},aliases:{},nullTokens:{},requiredFields:["sku","title","priceMinor","currency"],htmlPolicy:"basic-v1",weightRounding:"half-up-gram-v1"});
}
export const groupingConfig=groupingConfigSchema.parse({namespace:"catalog-family-v1",familyAttribute:"familyId",skuFamilies:{},missingFamily:"REVIEW",optionFields:{size:"attributes.size",colour:"attributes.colour"},productAttributes:["material"]});

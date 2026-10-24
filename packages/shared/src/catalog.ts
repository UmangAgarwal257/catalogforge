import { z } from "zod";
import taxonomyData from "./taxonomy.json";
export const taxonomySchema = z.object({version:z.string().min(1),categories:z.array(z.object({key:z.string().min(1).max(100),label:z.string().min(1).max(150)}).strict()).min(1).max(32)}).strict().refine(t=>new Set(t.categories.map(c=>c.key)).size===t.categories.length,"Duplicate taxonomy keys");
export const TAXONOMY=taxonomySchema.parse(taxonomyData);
export const CATEGORY_KEYS=TAXONOMY.categories.map(c=>c.key);
const profileSchema=z.object({id:z.string(),name:z.string(),version:z.literal(1),headers:z.array(z.string()).length(10),decimal:z.enum([".",","]),grouping:z.enum([".",","]),weightUnit:z.enum(["kg","g"]),description:z.string()}).strict();
export const SUPPLIER_PROFILES=z.array(profileSchema).parse([
 {id:"euro-catalog-v1",name:"Euro wholesale catalog",version:1,headers:["SKU","Family","Title","Description","Price","Currency","Weight (kg)","Size","Colour","Material"],decimal:",",grouping:".",weightUnit:"kg",description:"Decimal comma; explicit EUR/GBP/USD currency; kilograms; Family groups products; Size and Colour identify options."},
 {id:"uk-trade-v1",name:"UK trade catalog",version:1,headers:["Item code","Product code","Product name","Details","Unit price","Currency code","Mass (g)","Option","Color","Composition"],decimal:".",grouping:",",weightUnit:"g",description:"Decimal point; explicit EUR/GBP/USD currency; grams; Product code groups products; Option and Color identify variants."}
]);
export const profileSnapshotSchema=z.object({profile:profileSchema,taxonomy:taxonomySchema,configHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export type ProfileSnapshot=z.infer<typeof profileSnapshotSchema>;
export function getSupplierProfile(id:string){return SUPPLIER_PROFILES.find(p=>p.id===id);}

/** Stable JSON for frozen configuration identities, independent of JSONB key ordering. */
export function catalogConfigJson(value: unknown): string {
 if (Array.isArray(value)) return `[${value.map(catalogConfigJson).join(",")}]`;
 if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b,"en")).map(([k,v])=>`${JSON.stringify(k)}:${catalogConfigJson(v)}`).join(",")}}`;
 return JSON.stringify(value);
}

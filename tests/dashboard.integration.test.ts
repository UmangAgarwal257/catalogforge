import {afterAll,afterEach,beforeEach,expect,it,vi} from "vitest";
import {getDb,disconnectDatabase} from "@catalogforge/db";
import {createTerracottaFixture,removeFixture} from "@catalogforge/enrichment/fixture";
import {dashboardData} from "../apps/web/src/features/dashboard/data";
import {GET} from "../apps/web/src/app/api/dashboard/route";
const db=getDb();let f:Awaited<ReturnType<typeof createTerracottaFixture>>;
beforeEach(async()=>{f=await createTerracottaFixture();});afterEach(async()=>{vi.unstubAllEnvs();await removeFixture(f.storeId);});afterAll(disconnectDatabase);
async function imported(name:string,status:"COMPLETED"|"FAILED"|"PENDING",state?:string,errorCode?:string){return db.import.create({data:{storeId:f.storeId,supplierId:f.supplierId,originalFilename:name,storageKey:"isolated-dashboard",fileSha256:"a".repeat(64),parserVersion:"test",idempotencyKey:crypto.randomUUID(),status,...(state?{catalogTask:{create:{state,errorCode,phase:"CLEANING"}}}:{})}});}
it("counts terminal failures separately from quota pauses, mapping issues and ongoing catalog work",async()=>{
 await imported("parse-failed.csv","FAILED");await imported("catalog-failed.csv","COMPLETED","FAILED","CLEANING_FAILED");await imported("quota.csv","COMPLETED","WAITING","FREE_TIER_QUOTA");await imported("mapping.csv","COMPLETED","NEEDS_MAPPING","MAPPING_HEADER");await imported("parsing.csv","PENDING");
 const data=await dashboardData(f.storeId);expect(data.kpis).toMatchObject({totalProducts:1,needingReview:1,approved:0,published:0,failedImports:2,quotaPaused:1,activeImports:2});expect(data.failures.map(i=>i.originalFilename).sort()).toEqual(["catalog-failed.csv","parse-failed.csv"]);
 expect(data.imports).toHaveLength(5);expect(data.actions).toHaveLength(1);expect(JSON.stringify(data)).not.toMatch(/storageKey|DATABASE_URL|fileSha256/);
});
it("does not call an un-audited pointer a visible publication and scopes every aggregate to the server store",async()=>{
 const revision=await db.productRevision.create({data:{storeId:f.storeId,productId:f.productId,status:"APPROVED",title:"Un-audited approved revision"}});await db.product.update({where:{id:f.productId},data:{publishedRevisionId:revision.id}});
 const data=await dashboardData(f.storeId);expect(data.kpis.approved).toBe(1);expect(data.kpis.published).toBe(0);
 const empty=await db.store.create({data:{name:"Isolated dashboard empty store"}});try{expect((await dashboardData(empty.id)).kpis).toEqual({totalProducts:0,needingReview:0,approved:0,published:0,activeImports:0,failedImports:0,quotaPaused:0});}finally{await db.store.delete({where:{id:empty.id}});}
 vi.stubEnv("NODE_ENV","development");vi.stubEnv("DEV_INGESTION_ENABLED","true");vi.stubEnv("DEV_STORE_ID",f.storeId);vi.stubEnv("LOCAL_UPLOAD_DIR","/tmp/catalogforge-dashboard-isolated");
 const response=await GET(new Request(`http://localhost/api/dashboard?storeId=${crypto.randomUUID()}`));expect(response.status).toBe(200);expect(await response.json()).toMatchObject({kpis:{totalProducts:1}});expect(response.headers.get("cache-control")).toBe("no-store");
});
it("preserves local-development, loopback and origin denial statuses without leaking raw infrastructure exceptions",async()=>{
 vi.stubEnv("NODE_ENV","development");vi.stubEnv("DEV_INGESTION_ENABLED","true");vi.stubEnv("DEV_STORE_ID",f.storeId);vi.stubEnv("LOCAL_UPLOAD_DIR","/tmp/catalogforge-dashboard-isolated");
 expect((await GET(new Request("http://localhost/api/dashboard",{headers:{origin:"https://attacker.example"}}))).status).toBe(403);
 expect((await GET(new Request("http://public.example/api/dashboard"))).status).toBe(403);
 vi.stubEnv("NODE_ENV","production");expect((await GET(new Request("http://localhost/api/dashboard"))).status).toBe(404);
});

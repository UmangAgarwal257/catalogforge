// @vitest-environment jsdom
import { afterEach,beforeEach,expect,it,vi } from "vitest";
import { cleanup,render,screen,waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReviewEditor } from "./editor";
import { ReviewQueue } from "./queue";
import type { ReviewDetail } from "@catalogforge/review/contracts";
const revisionId="00000000-0000-4000-8000-000000000001",productId="00000000-0000-4000-8000-000000000002",variantId="00000000-0000-4000-8000-000000000003";
let detail:ReviewDetail;
const json=(v:unknown,status=200)=>new Response(JSON.stringify(v),{status});
const mock=vi.fn<(url:string,init?:RequestInit)=>Promise<Response>>();
beforeEach(()=>{
 detail={revision:{id:revisionId,productId,title:"Terracotta Pot",descriptionHtml:"<p>Not frost-proof.</p>",categoryKey:null,tags:[],attributes:{colour:"terracota"},status:"NEEDS_REVIEW",editVersion:1,manualFieldPaths:[],reviewReasons:[{code:"PRICE_REQUIRED"}],product:{supplier:{name:"Pots supplier"},publishedRevisionId:null},variants:[{variantId,options:{diameter:"30"},priceMinor:null,currency:null,weightGrams:1800,manualFieldPaths:[],variant:{sku:"tc-pl-30"}}]},blockers:[{id:"a".repeat(64),field:"categoryKey",code:"WITHHELD_SUGGESTION",message:"Review category",kind:"SUGGESTION",evidenceRequired:false,value:"Home & Garden > Planters"}],taxonomy:["Home & Garden > Planters"],history:[],enrichment:[{id:"live-record",createdAt:"2026-10-24T00:00:00Z",state:"COMPLETED",facts:[],result:{accepted:[],applied:[],withheld:[{path:"categoryKey",value:"Home & Garden > Planters",confidence:100,origin:"INFERRED_SUGGESTION",factIds:[]}],issues:[{code:"UNVERIFIED_SUGGESTION",field:"categoryKey"}]}}]};
 mock.mockImplementation(async(url,init)=>{
  if(url.includes("/evidence"))return json({rows:[{id:variantId,sheetIndex:0,sheetName:"Pots",rowNumber:15,status:"PENDING",rawCells:[{columnIndex:0,header:"Notes",value:"<script>attack()</script>"},{columnIndex:1,header:"Notes",value:"00123"}],issues:[],originalFilename:"pots.csv",cleaning:{evidence:[]}}],hasMore:false});
  if(init?.method){const body=JSON.parse(String(init.body));detail.revision={...detail.revision,...body.fields,editVersion:detail.revision.editVersion+1};return json({reused:false});}
  if(url.startsWith("/api/product-revisions?"))return json({proposals:[{id:revisionId,productId,title:"Terracotta Pot",status:"NEEDS_REVIEW",editVersion:1,createdAt:"2026-10-24T00:00:00Z",product:{supplier:{name:"Pots supplier"}},_count:{variants:1}}],hasMore:true});
  return json(detail);
 });vi.stubGlobal("fetch",mock);
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.restoreAllMocks();mock.mockReset();});
it("shows applied/withheld distinction, source positions and escapes supplier HTML",async()=>{
 render(<ReviewEditor productId={productId} revisionId={revisionId}/>);
 await screen.findByLabelText("Title");expect(screen.getByText("Withheld · confidence 100%")).toBeTruthy();
 expect(await screen.findByText("<script>attack()</script>")).toBeTruthy();expect(document.querySelector("script")).toBeNull();
 expect(screen.getByText("Column 1")).toBeTruthy();expect(screen.getByText("Column 2")).toBeTruthy();
});
it("records explicit category adoption as an edit decision and submits price as integer string",async()=>{
 render(<ReviewEditor productId={productId} revisionId={revisionId}/>);const user=userEvent.setup();await screen.findByLabelText("Title");
 await user.click(screen.getByRole("button",{name:"Use suggested category as merchant choice"}));
 await user.type(screen.getByLabelText("Price for tc-pl-30"),"34.99");await user.selectOptions(screen.getByLabelText("Currency for tc-pl-30"),"EUR");
 await user.click(screen.getByRole("button",{name:"Save changes"}));await screen.findByText("Changes saved. Approval blockers have been refreshed.");
 const call=mock.mock.calls.find(([,init])=>init?.method==="PATCH")!;const body=JSON.parse(String(call[1]?.body));
 expect(body.expectedEditVersion).toBe(1);expect(body.fields.categoryKey).toBe("Home & Garden > Planters");expect(body.variants[0]).toMatchObject({priceMinor:"3499",currency:"EUR"});expect(body.decisions[0].disposition).toBe("ADOPT_CATEGORY");
});
it("reuses the exact request after uncertain mutation and pauses editing",async()=>{
 const base=mock.getMockImplementation()!;let count=0;const payloads:string[]=[];
 mock.mockImplementation(async(url,init)=>{if(init?.method==="PATCH"){payloads.push(String(init.body));if(++count===1)throw Error("Connection lost");}return base(url,init);});
 render(<ReviewEditor productId={productId} revisionId={revisionId}/>);const user=userEvent.setup();const title=await screen.findByLabelText("Title");await user.type(title," edited");await user.click(screen.getByRole("button",{name:"Save changes"}));
 await screen.findByRole("button",{name:"Retry save"});expect(title.closest("fieldset")?.disabled).toBe(true);await user.click(screen.getByRole("button",{name:"Retry save"}));
 await screen.findByText("Changes saved. Approval blockers have been refreshed.");expect(payloads).toHaveLength(2);expect(payloads[0]).toBe(payloads[1]);
});
it("preserves local text on stale edit and does not silently reload",async()=>{
 const base=mock.getMockImplementation()!;mock.mockImplementation(async(url,init)=>init?.method?json({error:{message:"This proposal changed. Reload before saving."}},409):base(url,init));
 render(<ReviewEditor productId={productId} revisionId={revisionId}/>);const user=userEvent.setup();const title=await screen.findByLabelText("Title");await user.clear(title);await user.type(title,"Unsaved merchant title");await user.click(screen.getByRole("button",{name:"Save changes"}));
 await screen.findByRole("alert");expect((title as HTMLInputElement).value).toBe("Unsaved merchant title");expect(screen.getByRole("button",{name:"Reload latest saved version"})).toBeTruthy();
});
it("shows approved revisions read-only without mutation actions",async()=>{
 detail.revision.status="APPROVED";render(<ReviewEditor productId={productId} revisionId={revisionId}/>);const title=await screen.findByLabelText("Title");expect(title.closest("fieldset")?.disabled).toBe(true);expect(screen.queryByRole("button",{name:"Save changes"})).toBeNull();expect(screen.getByText(/This revision is read-only/)).toBeTruthy();
});
it("browses the queue with bounded page sizes, search and page navigation",async()=>{
 render(<ReviewQueue/>);const user=userEvent.setup();await screen.findByRole("link",{name:"Terracotta Pot"});await user.selectOptions(screen.getByLabelText("Per page"),"10");await user.click(screen.getByRole("button",{name:"Next"}));
 await waitFor(()=>expect(mock.mock.calls.some(([url])=>url.includes("page=2&pageSize=10"))).toBe(true));
 await user.type(screen.getByLabelText("Search title or SKU"),"tc-pl");await waitFor(()=>expect(mock.mock.calls.some(([url])=>url.includes("search=tc-pl"))).toBe(true));
});

it("saves 101+ variants as bounded pages and prevents losing unsaved edits during navigation",async()=>{
 detail.revision.variants=Array.from({length:101},(_,i)=>({...detail.revision.variants[0]!,variantId:`00000000-0000-4000-8000-${String(i+10).padStart(12,"0")}`,options:{size:String(i)},variant:{sku:`SKU-${i}`}}));
 const base=mock.getMockImplementation()!;mock.mockImplementation(async(url,init)=>{if(init?.method==="PATCH"){const body=JSON.parse(String(init.body));for(const patch of body.variants){const v=detail.revision.variants.find(v=>v.variantId===patch.variantId)!;Object.assign(v,patch);}}return base(url,init);});
 render(<ReviewEditor productId={productId} revisionId={revisionId}/>);const user=userEvent.setup();await screen.findByLabelText("Price for SKU-0");await user.type(screen.getByLabelText("Price for SKU-0"),"12.50");
 await user.click(screen.getAllByRole("button",{name:"Next"})[0]!);expect(await screen.findByText(/Save this page before changing variant pages/)).toBeTruthy();expect(screen.queryByLabelText("Price for SKU-10")).toBeNull();
 await user.click(screen.getByRole("button",{name:"Save changes"}));await screen.findByText("Changes saved. Approval blockers have been refreshed.");
 for(let i=0;i<10;i++)await user.click(screen.getAllByRole("button",{name:"Next"})[0]!);
 await screen.findByLabelText("Price for SKU-100");await user.type(screen.getByLabelText("Price for SKU-100"),"19.99");await user.click(screen.getByRole("button",{name:"Save changes"}));await waitFor(()=>expect(mock.mock.calls.filter(([,i])=>i?.method==="PATCH")).toHaveLength(2));
 const bodies=mock.mock.calls.filter(([,i])=>i?.method==="PATCH").map(([,i])=>JSON.parse(String(i?.body)));expect(bodies.map(b=>b.variants.length)).toEqual([1,1]);expect(bodies.map(b=>b.expectedEditVersion)).toEqual([1,2]);expect(bodies.map(b=>b.variants[0].priceMinor)).toEqual(["1250","1999"]);
});

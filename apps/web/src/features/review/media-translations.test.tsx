// @vitest-environment jsdom
import {afterEach,beforeEach,it,expect,vi} from "vitest";
import {render,screen,cleanup,waitFor} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {MediaTranslations} from "./media-translations";
vi.mock("next/navigation",()=>({useRouter:()=>({push:vi.fn()}),usePathname:()=>window.location.pathname,useSearchParams:()=>new URLSearchParams(window.location.search)}));
const id="00000000-0000-4000-8000-000000000001",asset="00000000-0000-4000-8000-000000000002",variant="00000000-0000-4000-8000-000000000003";
const fetchMock=vi.fn();beforeEach(()=>vi.stubGlobal("fetch",fetchMock));afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.restoreAllMocks();fetchMock.mockReset();});
const json=(data:unknown)=>new Response(JSON.stringify(data),{status:200});
it("uploads real browser files sequentially and leaves unknown filenames unresolved until explicit assignment",async()=>{
 fetchMock.mockImplementation(async(url:string,init?:RequestInit)=>{if(init?.method==="POST")return json({reused:false});return json(url.startsWith("/api/media?")?{items:[{id:asset,filename:"unresolved.jpg",url:`/api/media/${asset}`,width:100,height:100,suggestedVariantId:null,assigned:0}],hasMore:true}:{items:[]});});
 const refresh=vi.fn();render(<MediaTranslations revisionId={id} version={3} status="DRAFT" variants={[{variantId:variant,variant:{sku:"000123"}}]} dirty={false} refresh={refresh}/>);
 await screen.findByText(/unresolved.jpg · 100/);expect(fetchMock.mock.calls.some(([,init])=>init?.method==="POST")).toBe(false);
 const user=userEvent.setup();await user.selectOptions(screen.getByRole("combobox",{name:/Assign to/}),variant);expect((screen.getByRole("button",{name:"Next photos"}) as HTMLButtonElement).disabled).toBe(true);await user.click(screen.getByRole("button",{name:"Save photo assignment"}));
 await waitFor(()=>expect(refresh).toHaveBeenCalled());const mutation=fetchMock.mock.calls.find(([,init])=>init?.method==="POST")!;expect(JSON.parse(mutation[1].body)).toMatchObject({expectedEditVersion:3,variantId:variant,action:"ASSIGN"});
 const files=[new File(["photo one"],"one.jpg",{type:"image/jpeg"}),new File(["photo two"],"two.jpg",{type:"image/jpeg"})];await user.upload(screen.getByLabelText("Upload JPEG, PNG or WebP photos"),files);await screen.findByText("2 of 2 photos accepted; 0 duplicates reused. 0 failed.");expect(fetchMock.mock.calls.filter(([url])=>url==="/api/media")).toHaveLength(2);
});
it("shows genuine audit fields, quota eligibility, and requires explicit translation attestation",async()=>{
 const base={id:asset,locale:"de",status:"NEEDS_REVIEW",editVersion:2,sourceSnapshot:{title:"Pot"},content:{title:"Topf"},manualFields:[],nextAttemptAt:null,errorCode:null,attempts:[{number:1,model:"gemini-3.5-flash-lite",inputTokens:134,outputTokens:106,latencyMs:7576,usageKind:"REPORTED"}]};
 fetchMock.mockImplementation(async(url:string,init?:RequestInit)=>init?.method?json({reused:false}):json(url.endsWith("/translations")?{items:[base,{...base,id:variant,locale:"fr",status:"QUOTA_PAUSED",content:null,nextAttemptAt:"2026-10-25T09:09:41.612Z",errorCode:"FREE_TIER_QUOTA",attempts:[]}]}:{items:[],hasMore:false}));
 render(<MediaTranslations revisionId={id} version={4} status="APPROVED" variants={[]} dirty={false} refresh={vi.fn()}/>);const button=await screen.findByRole("button",{name:"Approve German"});expect((button as HTMLButtonElement).disabled).toBe(true);expect(screen.getByText(/French · QUOTA PAUSED/)).toBeTruthy();expect(screen.getByText(/Eligible to retry/)).toBeTruthy();expect(screen.getByText(/134 input \/ 106 output tokens/)).toBeTruthy();
 const user=userEvent.setup();await user.click(screen.getByRole("checkbox"));await user.click(button);await waitFor(()=>expect(fetchMock.mock.calls.some(([,init])=>init?.method==="POST")).toBe(true));const call=fetchMock.mock.calls.find(([,init])=>init?.method==="POST")!;expect(JSON.parse(call[1].body)).toMatchObject({action:"APPROVE",attestRestrictions:true,expectedEditVersion:2});
});
it("keeps all controls disabled while English edits are unsaved",async()=>{fetchMock.mockResolvedValue(json({items:[],hasMore:false}));render(<MediaTranslations revisionId={id} version={2} status="DRAFT" variants={[]} dirty={true} refresh={vi.fn()}/>);expect(await screen.findByText(/Save your English changes/)).toBeTruthy();expect((screen.getByLabelText("Upload JPEG, PNG or WebP photos") as HTMLInputElement).disabled).toBe(true);});
it("reports unsaved translation activity and does not refresh the English form during translation saves",async()=>{
 const translation={id:asset,locale:"de",status:"NEEDS_REVIEW",editVersion:2,sourceSnapshot:{title:"Pot"},content:{title:"Topf"},manualFields:[],nextAttemptAt:null,errorCode:null,attempts:[]};
 fetchMock.mockImplementation(async(url:string,init?:RequestInit)=>init?.method?json({reused:false}):json(url.endsWith("/translations")?{items:[translation]}:{items:[],hasMore:false}));
 const activity=vi.fn(),refresh=vi.fn();render(<MediaTranslations view="translations" onActivityChange={activity} revisionId={id} version={4} status="APPROVED" variants={[]} dirty={false} refresh={refresh}/>);
 const title=await screen.findByRole("textbox",{name:"German · title"});await userEvent.setup().type(title," corrected");await waitFor(()=>expect(activity).toHaveBeenLastCalledWith(true));await userEvent.setup().click(screen.getByRole("button",{name:"Save German corrections"}));await screen.findByText("Translation action saved. Approval and publication remain separate.");expect(refresh).not.toHaveBeenCalled();await waitFor(()=>expect(activity).toHaveBeenLastCalledWith(false));
});
it("does not misrepresent HTTP errors as an empty successful translation list",async()=>{
 fetchMock.mockImplementation(async(url:string)=>url.endsWith("/translations")?new Response("{}",{status:503}):json({items:[],hasMore:false}));
 render(<MediaTranslations revisionId={id} version={1} status="DRAFT" variants={[]} dirty={false} refresh={vi.fn()}/>);await screen.findByRole("alert");expect(screen.getByRole("button",{name:"Retry loading workspace"})).toBeTruthy();
});

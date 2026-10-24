// @vitest-environment jsdom
import {afterEach,beforeEach,it,expect,vi} from "vitest";
import {render,screen,cleanup,waitFor} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {Dashboard} from "./dashboard";
import {ReviewWorkspace} from "../review/workspaces";
vi.mock("next/navigation",()=>({usePathname:()=>"/dashboard",useRouter:()=>({replace:vi.fn(),refresh:vi.fn()})}));
const fetchMock=vi.fn();beforeEach(()=>vi.stubGlobal("fetch",fetchMock));afterEach(()=>{cleanup();vi.unstubAllGlobals();fetchMock.mockReset();});
const data={kpis:{totalProducts:3,needingReview:2,approved:1,published:1,activeImports:1,failedImports:1,quotaPaused:1},imports:[],actions:[],failures:[{id:"failed-id",originalFilename:"bad.csv",status:"FAILED",errorMessage:"Malformed source file.",catalogTask:null}]};
it("recovers from a dashboard error without keeping the error screen after a successful retry",async()=>{
 fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({error:{message:"Temporary failure"}}),{status:503})).mockResolvedValueOnce(new Response(JSON.stringify(data)));
 render(<Dashboard/>);await screen.findByRole("alert");await userEvent.setup().click(screen.getByRole("button",{name:"Try again"}));await screen.findByRole("region",{name:"Catalog KPIs"});expect(screen.queryByRole("alert")).toBeNull();expect(screen.getByRole("link",{name:"bad.csv"}).getAttribute("href")).toBe("/?import=failed-id#source-preview");expect(screen.getByRole("link",{name:/Published 1/}).getAttribute("href")).toBe("/shop");
});
it("paginates workspace revisions instead of silently losing items after the first page",async()=>{
 fetchMock.mockImplementation(async()=>new Response(JSON.stringify({proposals:[{id:"revision",productId:"product",title:"Mug",status:"APPROVED",editVersion:2,createdAt:"2026-10-24T00:00:00Z",product:{supplier:{name:"Supplier"}},_count:{variants:2}}],hasMore:true})));
 render(<ReviewWorkspace kind="translations"/>);await screen.findByRole("link",{name:"Open translations"});await userEvent.setup().click(screen.getByRole("button",{name:"Next"}));await waitFor(()=>expect(fetchMock.mock.calls.some(([url])=>String(url).includes("page=2&pageSize=25"))).toBe(true));expect(screen.getByRole("link",{name:"Open translations"}).getAttribute("href")).toContain("?tab=translations");expect(screen.getByRole("columnheader",{name:"English status"})).toBeTruthy();
});
it("provides workspace retry and empty states without a full browser reload",async()=>{
 fetchMock.mockResolvedValueOnce(new Response("{}",{status:503})).mockResolvedValueOnce(new Response(JSON.stringify({proposals:[],hasMore:false})));
 render(<ReviewWorkspace kind="media"/>);await screen.findByRole("alert");await userEvent.setup().click(screen.getByRole("button",{name:"Try again"}));await screen.findByText("No matching revisions");expect(screen.queryByRole("alert")).toBeNull();
});

// @vitest-environment jsdom
import {afterEach,expect,it,vi} from "vitest";
import {cleanup,render} from "@testing-library/react";
import {useNavigationGuard} from "./common";
vi.mock("next/navigation",()=>({usePathname:()=>"/products"}));
function Guard({dirty=true}:{dirty?:boolean}){useNavigationGuard(dirty);return null;}
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();window.history.replaceState(null,"","/");});
it("cancels dirty cross-route Back/Forward before unmount and allows same-editor sections",()=>{
 const navigation=new EventTarget();Object.defineProperty(window,"navigation",{configurable:true,value:navigation});
 window.history.replaceState(null,"","/products/one/revisions/two?tab=media");
 const confirm=vi.spyOn(window,"confirm").mockReturnValue(false);
 const view=render(<Guard/>);
 const traverse=(url:string)=>{const event=new Event("navigate",{cancelable:true});Object.assign(event,{navigationType:"traverse",destination:{url}});navigation.dispatchEvent(event);return event;};
 expect(traverse("http://localhost:3000/dashboard").defaultPrevented).toBe(true);
 expect(traverse(window.location.origin+"/products/one/revisions/two?tab=translations").defaultPrevented).toBe(false);
 expect(confirm).toHaveBeenCalledTimes(1);
 confirm.mockReturnValue(true);expect(traverse("http://localhost:3000/media").defaultPrevented).toBe(false);
 view.rerender(<Guard dirty={false}/>);confirm.mockReturnValue(false);expect(traverse("http://localhost:3000/dashboard").defaultPrevented).toBe(false);
});

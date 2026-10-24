// @vitest-environment jsdom
import {cleanup,render,screen} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {afterEach,expect,it} from "vitest";
import {ProductOptions} from "./product-options";
afterEach(cleanup);
it("selects exact variant prices and escapes supplier options without inventing stock",async()=>{
 render(<ProductOptions variants={[{id:"one",sku:"000123",priceMinor:"1250",currency:"EUR",weightGrams:250,options:{size:"350 ml"}},{id:"two",sku:"000124",priceMinor:"9223372036854775807",currency:"EUR",weightGrams:null,options:{size:"<script>alert(1)</script>"}}]}/>);
 expect(screen.getByText("EUR 12.50")).toBeTruthy();await userEvent.setup().selectOptions(screen.getByRole("combobox",{name:"Variant"}),"two");expect(screen.getByText("EUR 92233720368547758.07")).toBeTruthy();expect(screen.getByText("SKU 000124")).toBeTruthy();expect(document.querySelector("script")).toBeNull();expect(screen.getByText(/Stock availability has not been provided/)).toBeTruthy();
});

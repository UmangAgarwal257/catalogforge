import { expect,it } from "vitest";
import { decimalToMinor,minorToDecimal,mutationSchema,parseWeightGrams } from "./contracts";
it.each([["24.99","2499"],["0.01","1"],["0001.2","120"],["92233720368547758.07","9223372036854775807"]])("converts %s exactly",(value,minor)=>expect(decimalToMinor(value)).toBe(minor));
it.each(["1,23","1e3","-1","1.234","92233720368547758.08"])("rejects ambiguous, negative or overflowing money: %s",value=>expect(()=>decimalToMinor(value)).toThrow());
it("keeps missing distinct from zero",()=>{expect(decimalToMinor("")).toBeNull();expect(decimalToMinor("0")).toBe("0");expect(minorToDecimal(null)).toBe("");expect(minorToDecimal("1")).toBe("0.01");});
it("rejects identity changes, invented categories and floating prices",()=>{
 const base={requestId:crypto.randomUUID(),expectedEditVersion:1};
 expect(mutationSchema.safeParse({...base,fields:{sku:"NEW"}}).success).toBe(false);
 expect(mutationSchema.safeParse({...base,fields:{categoryKey:"Invented"}}).success).toBe(false);
 expect(mutationSchema.safeParse({...base,variants:[{variantId:crypto.randomUUID(),priceMinor:1.2}]}).success).toBe(false);
});

it("never silently serializes invalid weight as missing",()=>{
 for(const value of ["abc","1.5","-1","Infinity","2147483648"]) expect(()=>parseWeightGrams(value)).toThrow();
 expect(parseWeightGrams("")).toBeNull();expect(parseWeightGrams("1800")).toBe(1800);expect(parseWeightGrams("0")).toBe(0);
});

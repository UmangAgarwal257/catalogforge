import {describe,it,expect} from "vitest";
import sharp from "sharp";
import {safeFilename,verifyImage} from "./media";
import {validateTranslation,localeFrom} from "./translations";
describe("verified photos",()=>{
 it.each(["jpeg","png","webp"] as const)("fully decodes %s and bounds preview dimensions",async format=>{const bytes=await sharp({create:{width:1400,height:700,channels:3,background:"red"}})[format]().toBuffer();const image=await verifyImage(bytes);expect(image).toMatchObject({format,width:1400,height:700});const preview=await sharp(image.preview).metadata();expect(preview).toMatchObject({format:"webp",width:1200,height:600});});
 it("rejects disguised scripts, SVG, truncated images and oversized files",async()=>{for(const data of [Buffer.from('<svg onload="alert(1)"/>'),Buffer.from('not a jpeg'),Buffer.from([255,216,255,0]),Buffer.alloc(10485761)])await expect(verifyImage(data)).rejects.toThrow();});
 it("rejects excessive decoded dimensions without lifting the pixel limit",async()=>{const bytes=await sharp({create:{width:6000,height:4100,channels:3,background:"white"}}).png().toBuffer();await expect(verifyImage(bytes)).rejects.toMatchObject({code:"INVALID_IMAGE"});});
 it("discards path components and controls in display filenames",()=>{expect(safeFilename('../../private/\\photo\u0000.jpg')).toBe('photo.jpg');});
});
describe("translation boundaries",()=>{
 const source={title:"BrandA Pot 20 cm",descriptionHtml:"<p>Not frost-proof. Bring indoors below 0 °C. {{count}}</p>","attributes.brand":"BrandA"};
 const valid={fields:[{path:"title",value:"BrandA Topf 20 cm"},{path:"descriptionHtml",value:"<p>Nicht frostsicher. Unter 0 °C ins Haus bringen. {{count}}</p>"},{path:"attributes.brand",value:"BrandA"}]};
 it("preserves HTML, measurements, numbers, brand and placeholders while requiring human semantic review",()=>{expect(validateTranslation(source,valid).title).toBe("BrandA Topf 20 cm");});
 it.each([['title','BrandA Topf 21 cm'],['descriptionHtml','<p>Unter 0 °C ins Haus bringen.</p>'],['descriptionHtml','<script>alert(1)</script>'],['attributes.brand','BrandB']])("rejects protected changes to %s",(path,value)=>{expect(()=>validateTranslation(source,{fields:valid.fields.map(f=>f.path===path?{path,value}:f)})).toThrow();});
 it("rejects missing, duplicate and unsupported fields",()=>{expect(()=>validateTranslation(source,{fields:valid.fields.slice(1)})).toThrow();expect(()=>validateTranslation(source,{fields:[valid.fields[0],valid.fields[0],valid.fields[2]]})).toThrow();});
 it("falls back to English for unsupported locales",()=>{expect(localeFrom("de")).toBe("de");expect(localeFrom("fr")).toBe("fr");expect(localeFrom("zz")).toBe("en");});
});

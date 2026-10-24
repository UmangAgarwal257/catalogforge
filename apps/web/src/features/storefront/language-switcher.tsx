"use client";
import {useEffect} from "react";
import {usePathname,useSearchParams,useRouter} from "next/navigation";
import {storefrontCopy} from "./copy";
export function LanguageSwitcher(){
 const path=usePathname(),params=useSearchParams(),router=useRouter(),requested=params.get("lang")??"en",locale=["de","fr"].includes(requested)?requested:"en";
 useEffect(()=>{document.documentElement.lang=locale;},[locale]);
 const text=storefrontCopy(locale);
 return <label className="text-sm">{text.language}<select aria-label={locale==="de"?"Sprache des Shops":locale==="fr"?"Langue de la boutique":"Storefront language"} className="ml-2 min-h-11 rounded-lg border bg-background px-2 focus-visible:outline-2 focus-visible:outline-ring" value={locale} onChange={e=>{const q=new URLSearchParams(params);q.set("lang",e.target.value);document.documentElement.lang=e.target.value;router.push(`${path}?${q}`);}}><option value="en">English</option><option value="de">Deutsch</option><option value="fr">Français</option></select></label>;
}

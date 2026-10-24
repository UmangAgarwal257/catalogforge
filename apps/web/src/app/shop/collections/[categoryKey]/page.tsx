import {notFound} from "next/navigation";
import {categoryFromPath} from "@catalogforge/review/catalog";
import {Catalog,catalogPage} from "../../../../features/storefront/catalog";
export const dynamic="force-dynamic";
export default async function Page({params,searchParams}:{params:Promise<{categoryKey:string}>;searchParams:Promise<{page?:string}>}) {const categoryKey=categoryFromPath((await params).categoryKey);if(!categoryKey)notFound();return <Catalog category={categoryKey} page={catalogPage((await searchParams).page)}/>;}

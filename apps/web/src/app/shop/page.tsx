import {Catalog,catalogPage} from "../../features/storefront/catalog";
export const dynamic="force-dynamic";
export default async function Page({searchParams}:{searchParams:Promise<{page?:string;lang?:string}>}) {return <Catalog language={(await searchParams).lang} page={catalogPage((await searchParams).page)}/>;}

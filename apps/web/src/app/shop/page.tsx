import {Catalog,catalogPage} from "../../features/storefront/catalog";
export const dynamic="force-dynamic";
export default async function Page({searchParams}:{searchParams:Promise<{page?:string}>}) {return <Catalog page={catalogPage((await searchParams).page)}/>;}

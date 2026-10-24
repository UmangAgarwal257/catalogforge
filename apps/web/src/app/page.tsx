import {ImportDashboard} from "../features/imports/dashboard";
import {z} from "zod";
export default async function Home({searchParams}:{searchParams:Promise<{import?:string}>}){const id=z.uuid().safeParse((await searchParams).import);return <ImportDashboard initialImportId={id.success?id.data:undefined}/>;}

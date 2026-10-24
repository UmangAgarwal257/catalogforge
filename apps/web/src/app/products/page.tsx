import { ReviewQueue } from "../../features/review/queue";
export default async function Page({searchParams}:{searchParams:Promise<{status?:string}>}){const raw=(await searchParams).status??"OPEN";const status=["OPEN","ALL","DRAFT","NEEDS_REVIEW","APPROVED","REJECTED"].includes(raw)?raw:"OPEN";return <ReviewQueue key={status} initialStatus={status}/>;}

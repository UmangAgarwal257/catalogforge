import { ReviewEditor } from "../../../../../features/review/editor";
export default async function Page({params}:{params:Promise<{productId:string;revisionId:string}>}){return <ReviewEditor {...await params}/>;}

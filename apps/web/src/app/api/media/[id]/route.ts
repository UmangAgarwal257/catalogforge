import {mediaFile} from "@catalogforge/review/extras-http";
export const runtime="nodejs";
export async function GET(request:Request,context:{params:Promise<{id:string}>}) {return mediaFile(request,(await context.params).id);}

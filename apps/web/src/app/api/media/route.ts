import { extrasEndpoint } from "@catalogforge/review/extras-http";
export const runtime="nodejs";
export async function GET(request:Request) { return extrasEndpoint(request,"media"); }
export async function POST(request:Request) { return extrasEndpoint(request,"media"); }

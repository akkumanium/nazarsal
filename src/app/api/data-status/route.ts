import { getDataStatus } from "@/server/repository";
import { json } from "@/server/http";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function GET(){return json(await getDataStatus());}

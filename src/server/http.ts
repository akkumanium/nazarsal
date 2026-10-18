import { createHmac,randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { query } from "./db";

const clients=new Map<string,{count:number;until:number}>();
const salt=randomBytes(32);
export function json(value:unknown,status=200){return NextResponse.json(value,{status,headers:{"Cache-Control":"no-store"}});}
export function sameOrigin(request:Request):boolean{
  const origin=request.headers.get("origin");
  if(!origin)return true;
  try{
    const source=new URL(origin),target=new URL(request.url);
    // Next.js may normalize the internal URL to localhost; Host retains the
    // address used by the browser. Do not trust forwarded-host overrides.
    const host=request.headers.get("host")??target.host;
    return source.origin===origin&&source.protocol===target.protocol&&source.host===host;
  }catch{return false;}
}
export async function allowRecommendation(request:Request):Promise<boolean>{
  const now=Date.now(),ip=request.headers.get("x-forwarded-for")?.split(",")[0]??"local";
  const key=createHmac("sha256",salt).update(ip).digest("hex");
  if(clients.size>2000)for(const [id,b]of clients)if(b.until<now)clients.delete(id);
  const old=clients.get(key),bucket=old&&old.until>now?old:{count:0,until:now+60000};
  bucket.count++;clients.set(key,bucket);
  if(bucket.count>8)return false;
  const day=new Date().toISOString().slice(0,10),limit=Math.min(5000,Math.max(1,Number(process.env.MAX_DAILY_RECOMMENDATIONS)||500));
  const rows=await query(`INSERT INTO request_budgets(bucket,count,expires_at) VALUES($1,1,now()+interval '2 days')
    ON CONFLICT(bucket) DO UPDATE SET count=request_budgets.count+1 WHERE request_budgets.count<$2 RETURNING count`,[`recommend:${day}`,limit]);
  return rows.length>0;
}

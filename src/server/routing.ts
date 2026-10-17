import { createHash } from "node:crypto";
import { z } from "zod";
import type { Matrix, Point } from "@/lib/types";
import type { LineString, MultiLineString } from "geojson";
import { ConfigurationError, query } from "./db";

export class RoutingError extends Error { constructor(message: string) { super(message); this.name="RoutingError"; } }
const matrixSchema=z.object({durations:z.array(z.array(z.number().nonnegative().nullable())),distances:z.array(z.array(z.number().nonnegative().nullable()))});
async function ors(path:string,body:unknown):Promise<unknown> {
  if(!process.env.ORS_API_KEY) throw new ConfigurationError("Подключите маршрутизацию: заполните ORS_API_KEY.");
  const response=await fetch(`https://api.openrouteservice.org/v2/${path}`,{method:"POST",headers:{Authorization:process.env.ORS_API_KEY,"Content-Type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(12000),cache:"no-store"});
  if(!response.ok) throw new RoutingError(response.status===429?"Лимит сервиса маршрутов временно исчерпан.":"Сервис пешеходных маршрутов сейчас недоступен.");
  return response.json();
}
export function haversine(a:Point,b:Point):number {
  const r=Math.PI/180,dlat=(b.lat-a.lat)*r,dlon=(b.lon-a.lon)*r;
  return 6371000*2*Math.atan2(Math.sqrt(Math.sin(dlat/2)**2+Math.cos(a.lat*r)*Math.cos(b.lat*r)*Math.sin(dlon/2)**2),Math.sqrt(1-(Math.sin(dlat/2)**2+Math.cos(a.lat*r)*Math.cos(b.lat*r)*Math.sin(dlon/2)**2)));
}
async function cacheRead<T>(key:string):Promise<T|null>{
  const rows=await query<{payload:T}>("SELECT payload FROM route_cache WHERE cache_key=$1 AND expires_at>now()",[key]);return rows[0]?.payload??null;
}
async function cacheWrite(key:string,version:string,kind:string,payload:unknown){
  await query(`INSERT INTO route_cache(cache_key,dataset_version,kind,payload,expires_at) VALUES($1,$2,$3,$4,now()+interval '24 hours')
    ON CONFLICT(cache_key) DO UPDATE SET payload=EXCLUDED.payload,expires_at=EXCLUDED.expires_at`,[key,version,kind,JSON.stringify(payload)]);
}
function cacheKey(kind:string,version:string,ids:string[]){return createHash("sha256").update(JSON.stringify([kind,version,ids])).digest("hex");}
export async function walkingMatrix(origin:Point,points:Point[],ids:string[],version:string,originPoiId?:string):Promise<Matrix>{
  // Only a known public POI may be persisted as origin. GPS/map picks are never cached.
  const key=originPoiId?cacheKey("matrix",version,[originPoiId,...ids]):null;
  if(key){const cached=await cacheRead<Matrix>(key);if(cached)return cached;}
  const locations=[origin,...points].map(p=>[p.lon,p.lat]);
  const raw=await ors("matrix/foot-walking",{locations,metrics:["duration","distance"]});
  const parsed=matrixSchema.parse(raw);
  const n=locations.length;
  if(parsed.durations.length!==n||parsed.durations.some(row=>row.length!==n)||parsed.distances.length!==parsed.durations.length||parsed.distances.some(row=>row.length!==n))throw new RoutingError("Некорректная матрица маршрутов.");
  if(key)await cacheWrite(key,version,"matrix",parsed);
  return parsed;
}
const directionSchema=z.object({features:z.array(z.object({geometry:z.object({type:z.enum(["LineString","MultiLineString"]),coordinates:z.unknown()}),properties:z.object({segments:z.array(z.object({distance:z.number().nonnegative(),duration:z.number().nonnegative()})),way_points:z.array(z.number().int())})})).min(1)});
export type DirectionsResult={geometry:LineString|MultiLineString;segments:{distance:number;duration:number}[]};
export async function walkingDirections(points:Point[],maxSnapMeters=120):Promise<DirectionsResult>{
  // ORS omits per-leg segments when instructions are disabled; planning needs their durations.
  const parsed=directionSchema.parse(await ors("directions/foot-walking/geojson",{coordinates:points.map(p=>[p.lon,p.lat]),instructions:true,elevation:false,radiuses:points.map(()=>maxSnapMeters)}));
  const first=parsed.features[0];
  const geometry=first.geometry as LineString|MultiLineString;
  const coords=geometry.type==="LineString"?geometry.coordinates:geometry.coordinates.flat();
  if(first.properties.segments.length!==points.length-1||first.properties.way_points.length!==points.length)throw new RoutingError("Сервис вернул другой набор остановок.");
  points.forEach((point,i)=>{
    const c=coords[first.properties.way_points[i]];
    if(!c||!Number.isFinite(c[0])||!Number.isFinite(c[1])||haversine(point,{lon:c[0],lat:c[1]})>maxSnapMeters)throw new RoutingError("Не удалось подтвердить доступный пешеходный подход к объекту.");
  });
  return {geometry,segments:first.properties.segments};
}

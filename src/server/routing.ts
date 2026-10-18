import { createHash } from "node:crypto";
import { z } from "zod";
import type { Matrix, Point } from "@/lib/types";
import type { LineString, MultiLineString } from "geojson";
import { query } from "./db";
import { routingConfig, type RoutingProvider } from "./routing-config";
import type { TravelMode } from "@/lib/travel";

export class RoutingError extends Error { constructor(message: string) { super(message); this.name="RoutingError"; } }
const matrixSchema=z.object({durations:z.array(z.array(z.number().nonnegative().nullable())),distances:z.array(z.array(z.number().nonnegative().nullable()))});
async function routingRequest(url:string,options:RequestInit):Promise<unknown> {
  const {name,keyName}=routingConfig();
  let response:Response;
  try{
    response=await fetch(url,{...options,signal:AbortSignal.timeout(12000),cache:"no-store"});
  }catch(error){
    throw new RoutingError(error instanceof Error && ["TimeoutError","AbortError"].includes(error.name)
      ?`Сервис маршрутов ${name} не ответил за 12 секунд. Повторите запрос позже.`
      :`Не удалось соединиться с сервисом маршрутов ${name}. Проверьте соединение с сетью.`);
  }
  if(response.status===401||response.status===403)throw new RoutingError(`${name} отклонил доступ. Проверьте ${keyName} и разрешения ключа.`);
  if(!response.ok) throw new RoutingError(response.status===429?"Лимит сервиса маршрутов временно исчерпан.":"Сервис маршрутов сейчас недоступен.");
  try{return await response.json();}catch{throw new RoutingError(`${name} вернул некорректный ответ.`);}
}
async function ors(path:string,body:unknown):Promise<unknown> {
  const {apiKey}=routingConfig();
  return routingRequest(`https://api.openrouteservice.org/v2/${path}`,{method:"POST",headers:{Authorization:apiKey,"Content-Type":"application/json"},body:JSON.stringify(body)});
}
async function geoapify(path:string,params:Record<string,string>,body?:unknown):Promise<unknown> {
  const {apiKey}=routingConfig();
  const url=new URL(`https://api.geoapify.com/v1/${path}`);
  url.search=new URLSearchParams({...params,apiKey}).toString();
  return routingRequest(url.toString(),body===undefined?{method:"GET"}:{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
}

const geoapifyCellSchema=z.object({
  time:z.number().nonnegative().nullable(),distance:z.number().nonnegative().nullable(),
  source_index:z.number().int().nonnegative(),target_index:z.number().int().nonnegative()
}).nullable();
const geoapifyMatrixSchema=z.object({sources_to_targets:z.array(z.array(geoapifyCellSchema))});
function parseGeoapifyMatrix(raw:unknown,n:number):Matrix {
  const result=geoapifyMatrixSchema.safeParse(raw);
  if(!result.success||result.data.sources_to_targets.length!==n||result.data.sources_to_targets.some(row=>row.length!==n))throw new RoutingError("Некорректная матрица маршрутов Geoapify.");
  const rows=result.data.sources_to_targets;
  // Preserve directed and unreachable edges; never substitute straight-line estimates.
  rows.forEach((row,i)=>row.forEach((cell,j)=>{
    if(cell&&(cell.source_index!==i||cell.target_index!==j))throw new RoutingError("Некорректный порядок точек матрицы Geoapify.");
  }));
  return {durations:rows.map(row=>row.map(cell=>cell?.time??null)),distances:rows.map(row=>row.map(cell=>cell?.distance??null))};
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
function cacheKey(provider:RoutingProvider,kind:string,version:string,ids:string[],mode:TravelMode){return createHash("sha256").update(JSON.stringify([provider,"routes-v2",mode,kind,version,ids])).digest("hex");}
export async function routeMatrix(origin:Point,points:Point[],ids:string[],version:string,originPoiId?:string,mode:TravelMode="walk"):Promise<Matrix>{
  // Only a known public POI may be persisted as origin. GPS/map picks are never cached.
  const {provider}=routingConfig();
  const key=originPoiId?cacheKey(provider,"matrix",version,[originPoiId,...ids],mode):null;
  if(key){const cached=await cacheRead<Matrix>(key);if(cached)return cached;}
  const locations=[origin,...points].map(p=>[p.lon,p.lat]);
  const endpoints=locations.map(location=>({location}));
  const parsed=provider==="geoapify"
    ?parseGeoapifyMatrix(await geoapify("routematrix",{},{mode,units:"metric",sources:endpoints,targets:endpoints}),locations.length)
    :matrixSchema.parse(await ors(`matrix/${mode==="drive"?"driving-car":"foot-walking"}`,{locations,metrics:["duration","distance"]}));
  const n=locations.length;
  if(parsed.durations.length!==n||parsed.durations.some(row=>row.length!==n)||parsed.distances.length!==parsed.durations.length||parsed.distances.some(row=>row.length!==n))throw new RoutingError("Некорректная матрица маршрутов.");
  if(key)await cacheWrite(key,version,"matrix",parsed);
  return parsed;
}
const directionSchema=z.object({features:z.array(z.object({geometry:z.object({type:z.enum(["LineString","MultiLineString"]),coordinates:z.unknown()}),properties:z.object({segments:z.array(z.object({distance:z.number().nonnegative(),duration:z.number().nonnegative()})),way_points:z.array(z.number().int())})})).min(1)});
export type DirectionsResult={geometry:LineString|MultiLineString;segments:{distance:number;duration:number}[]};
const positionSchema=z.tuple([z.number().finite(),z.number().finite()]);
const geoapifyDirectionsSchema=z.object({features:z.array(z.object({
  geometry:z.object({type:z.literal("MultiLineString"),coordinates:z.array(z.array(positionSchema).min(2)).min(1)}),
  properties:z.object({legs:z.array(z.object({distance:z.number().nonnegative(),time:z.number().nonnegative()}))})
})).min(1)});
async function geoapifyDirections(points:Point[],maxSnapMeters:number,mode:TravelMode):Promise<DirectionsResult>{
  const result=geoapifyDirectionsSchema.safeParse(await geoapify("routing",{
    waypoints:points.map(p=>`${p.lat},${p.lon}`).join("|"),mode,units:"metric",format:"geojson",
    intermediate_waypoint_mode:"stopover",optimize_stops:"false"
  }));
  if(!result.success)throw new RoutingError("Некорректный маршрут Geoapify.");
  const {geometry,properties}=result.data.features[0];
  if(properties.legs.length!==points.length-1||geometry.coordinates.length!==properties.legs.length)throw new RoutingError("Сервис вернул другой набор остановок.");
  // Each Geoapify geometry line is one leg. Check both ends of every leg,
  // including both sides of intermediate stops, against the requested POIs.
  geometry.coordinates.forEach((line,i)=>{
    for(const [coordinate,point] of [[line[0],points[i]],[line[line.length-1],points[i+1]]] as const){
      if(haversine(point,{lon:coordinate[0],lat:coordinate[1]})>maxSnapMeters)throw new RoutingError("Не удалось подтвердить доступный подход или подъезд к объекту.");
    }
  });
  return {geometry,segments:properties.legs.map(leg=>({distance:leg.distance,duration:leg.time}))};
}
export async function routeDirections(points:Point[],maxSnapMeters=120,mode:TravelMode="walk"):Promise<DirectionsResult>{
  if(routingConfig().provider==="geoapify")return geoapifyDirections(points,maxSnapMeters,mode);
  // ORS omits per-leg segments when instructions are disabled; planning needs their durations.
  const parsed=directionSchema.parse(await ors(`directions/${mode==="drive"?"driving-car":"foot-walking"}/geojson`,{coordinates:points.map(p=>[p.lon,p.lat]),instructions:true,elevation:false,radiuses:points.map(()=>maxSnapMeters)}));
  const first=parsed.features[0];
  const geometry=first.geometry as LineString|MultiLineString;
  const coords=geometry.type==="LineString"?geometry.coordinates:geometry.coordinates.flat();
  if(first.properties.segments.length!==points.length-1||first.properties.way_points.length!==points.length)throw new RoutingError("Сервис вернул другой набор остановок.");
  points.forEach((point,i)=>{
    const c=coords[first.properties.way_points[i]];
    if(!c||!Number.isFinite(c[0])||!Number.isFinite(c[1])||haversine(point,{lon:c[0],lat:c[1]})>maxSnapMeters)throw new RoutingError("Не удалось подтвердить доступный подход или подъезд к объекту.");
  });
  return {geometry,segments:first.properties.segments};
}

import { mkdir,readFile,writeFile } from "node:fs/promises";
import { dirname } from "node:path";
export type OsmElement={type:"node"|"way"|"relation";id:number;lat?:number;lon?:number;tags?:Record<string,string>;timestamp?:string;version?:number;geometry?:{lat:number;lon:number}[];members?:unknown[]};
export type OverpassResponse={elements:OsmElement[];osm3s?:{timestamp_osm_base?:string};remark?:string};
export class OverpassError extends Error{constructor(message:string,public retryable=true){super(message);this.name="OverpassError";}}
export function parseOverpass(value:unknown):OverpassResponse{
  if(!value||typeof value!=="object")throw new OverpassError("Некорректный ответ Overpass");
  const response=value as OverpassResponse;
  if(!Array.isArray(response.elements)||response.remark)throw new OverpassError(response.remark?"Overpass вернул неполный результат":"В ответе Overpass нет массива объектов");
  if(response.elements.some(e=>!["node","way","relation"].includes(e.type)||!Number.isSafeInteger(e.id)))throw new OverpassError("Некорректные OSM-объекты");
  return response;
}
export function retryDelay(value:string|null,now=Date.now()):number{
  if(!value)return 0;
  const seconds=Number(value);
  if(Number.isFinite(seconds))return Math.max(0,seconds*1000);
  const date=Date.parse(value);return Number.isFinite(date)?Math.max(0,date-now):0;
}
export async function pause(ms:number){await new Promise(resolve=>setTimeout(resolve,ms));}
export async function requestOverpass(ql:string,rawPath?:string,force=false):Promise<OverpassResponse>{
  if(rawPath&&!force){try{return parseOverpass(JSON.parse(await readFile(rawPath,"utf8")));}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}}
  const url=process.env.OVERPASS_URL||"https://overpass-api.de/api/interpreter";
  let last:Error=new OverpassError("Overpass недоступен");
  for(let attempt=0;attempt<3;attempt++){
    await pause(Math.max(500,Number(process.env.OVERPASS_PAUSE_MS)||2000));
    try{
      const response=await fetch(url,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded","User-Agent":process.env.OSM_USER_AGENT||"NazarSalAstana/1.0 (hackathon prototype)"},body:new URLSearchParams({data:ql}),signal:AbortSignal.timeout(55000)});
      if(response.status===429){await pause(Math.max(2000,retryDelay(response.headers.get("retry-after"))));throw new OverpassError("Лимит Overpass");}
      if(!response.ok)throw new OverpassError(`Overpass HTTP ${response.status}`,response.status>=500||response.status===408);
      const json=parseOverpass(await response.json());
      if(rawPath){await mkdir(dirname(rawPath),{recursive:true});await writeFile(rawPath,JSON.stringify(json));}
      return json;
    }catch(error){last=error instanceof Error?error:new Error("Сетевая ошибка Overpass");if(error instanceof OverpassError&&!error.retryable)throw error;if(attempt<2)await pause(1500*2**attempt);}
  }
  throw last;
}

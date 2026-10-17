import { createHash,randomUUID } from "node:crypto";
import { mkdir,readFile,writeFile,open,unlink } from "node:fs/promises";
import { resolve,relative } from "node:path";
import osmtogeojson from "osmtogeojson";
import type { Feature,Geometry,MultiPolygon,Polygon } from "geojson";
import { normalizeOsmFeature,hasPublicAccess } from "@/lib/poi-normalizer";
import { normalizeText } from "@/lib/text";
import { poiSelectors,CATEGORIES,CATEGORY_IDS } from "@/lib/catalog";
import { query,transaction,type SqlClient } from "@/server/db";
import { requestOverpass,parseOverpass,type OverpassResponse } from "./overpass";
import { splitTile,tileBBox,type Tile } from "./grid";
import { analyzeCoverage,finalizeGeometry } from "./coverage";

const DATA=resolve("data");
const IMPORT_CONFIG=`overpass-v1:${createHash("sha256").update(JSON.stringify(CATEGORY_IDS.map(id=>[id,CATEGORIES[id].rules]))).digest("hex").slice(0,16)}`;
const snapshotPrefix=(snapshot:string)=>`[out:json][timeout:45][date:"${snapshot}"];`;
export async function discoverBoundary():Promise<{response:OverpassResponse;feature:Feature<Polygon|MultiPolygon>;relationId:string}>{
  let response:OverpassResponse,relationId=process.env.ASTANA_BOUNDARY_RELATION_ID||"3087156";
  if(process.env.ASTANA_BOUNDARY_FILE)response=parseOverpass(JSON.parse(await readFile(resolve(process.env.ASTANA_BOUNDARY_FILE),"utf8")));
  else{
    if(!relationId){
      const found=await requestOverpass('[out:json][timeout:45];rel["boundary"="administrative"]["admin_level"="4"](50.8,71.0,51.6,72.1);out tags;',resolve(DATA,"raw","boundary-candidates.json"),true);
      const candidates=found.elements.filter(e=>e.type==="relation"&&Object.entries(e.tags??{}).some(([k,v])=>["name","name:ru","name:en","name:kk"].includes(k)&&normalizeText(v)==="астана"||k==="name:en"&&v.toLowerCase()==="astana"));
      if(candidates.length!==1)throw new Error("Не удалось однозначно определить границу Астаны. Укажите ASTANA_BOUNDARY_RELATION_ID или ASTANA_BOUNDARY_FILE.");
      relationId=String(candidates[0].id);
    }
    if(!/^\d+$/.test(relationId))throw new Error("Некорректный идентификатор границы");
    response=await requestOverpass(`[out:json][timeout:45];rel(${relationId});out meta geom;`,resolve(DATA,"raw",`boundary-${relationId}.json`),true);
  }
  const geo=osmtogeojson(response as Parameters<typeof osmtogeojson>[0],{flatProperties:false});
  const features=geo.features.filter(f=>["Polygon","MultiPolygon"].includes(f.geometry?.type)&&String(f.id).startsWith("relation/"));
  const selected=relationId?features.filter(f=>f.id===`relation/${relationId}`):features.filter(f=>normalizeText(String(f.properties?.tags?.name??""))==="астана");
  if(selected.length!==1)throw new Error("Граница должна содержать один полный полигон Астаны");
  return {response,feature:selected[0] as Feature<Polygon|MultiPolygon>,relationId:String(selected[0].id).split("/")[1]};
}
async function insertTile(client:SqlClient,runId:string,tile:Tile){
  await client.query(`INSERT INTO import_tiles(run_id,id,parent_id,depth,min_x,min_y,max_x,max_y)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,[runId,tile.id,tile.parentId,tile.depth,tile.minX,tile.minY,tile.maxX,tile.maxY]);
}
export async function createImportRun(boundary:{feature:Feature<Polygon|MultiPolygon>;relationId:string},snapshot:string,configVersion=IMPORT_CONFIG):Promise<string>{
  if(!snapshot||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(snapshot))throw new Error("В ответе границы отсутствует время OSM-снимка. Укажите OSM_SNAPSHOT.");
  const id=randomUUID();
  await transaction(async client=>{
    await client.query(`INSERT INTO import_runs(id,status,snapshot_at,boundary_osm_id,boundary,config_version)
      VALUES($1,'collecting',$2,$3,ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($4),4326)),3)),$5)`,[id,snapshot,boundary.relationId,JSON.stringify(boundary.feature.geometry),configVersion]);
    const grid=await client.query(`SELECT g.i,g.j,ST_XMin(g.geom) min_x,ST_YMin(g.geom) min_y,ST_XMax(g.geom) max_x,ST_YMax(g.geom) max_y
      FROM import_runs r CROSS JOIN LATERAL ST_SquareGrid(5000,ST_Transform(r.boundary,32642)) g
      WHERE r.id=$1 AND ST_Intersects(g.geom,ST_Transform(r.boundary,32642))`,[id]);
    for(const row of grid.rows)await insertTile(client,id,{id:`${row.i}_${row.j}`,parentId:null,depth:0,minX:row.min_x,minY:row.min_y,maxX:row.max_x,maxY:row.max_y});
  });
  return id;
}
async function newRun():Promise<{id:string;snapshot:string}>{
  const boundary=await discoverBoundary();
  const snapshot=process.env.OSM_SNAPSHOT||boundary.response.osm3s?.timestamp_osm_base;
  if(!snapshot)throw new Error("В ответе границы отсутствует время OSM-снимка");
  const id=await createImportRun(boundary,snapshot);
  await mkdir(resolve(DATA,"raw",id),{recursive:true});
  await writeFile(resolve(DATA,"raw",id,"boundary.json"),JSON.stringify(boundary.response));
  return {id,snapshot};
}
export async function persistResponse(runId:string,tile:Tile,response:OverpassResponse,rawPath:string){
  const rawById=new Map(response.elements.map(e=>[`${e.type}/${e.id}`,e]));
  const geo=osmtogeojson(response as Parameters<typeof osmtogeojson>[0],{flatProperties:false});
  return persistFeatures(runId,tile,geo.features as Feature<Geometry>[],rawPath,rawById);
}
export async function persistFeatures(runId:string,tile:Tile,features:Feature<Geometry>[],rawPath:string,rawById=new Map<string,import("./overpass").OsmElement>()){
  await transaction(async client=>{
    let count=0;
    for(const f of features){
      if(!f.geometry)continue;
      if(f.properties?.tainted)throw new Error(`Неполная геометрия OSM ${f.id}`);
      const raw=rawById.get(String(f.id));
      const tags=raw?.tags??f.properties?.tags??{};
      const poi=normalizeOsmFeature(f as Feature<Geometry>,raw);
      if(poi){
        await client.query(`INSERT INTO poi(run_id,id,osm_type,osm_id,name,named,names,normalized_name,search_text,address,description,tags,features,category_ids,geom,opening_hours,source_updated_at,source_url,public_access)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($15),4326)),$16,$17,$18,$19)
          ON CONFLICT(run_id,id) DO NOTHING`,[runId,poi.id,poi.osmType,poi.osmId,poi.name,poi.named,JSON.stringify(poi.names),normalizeText(poi.name),normalizeText([...Object.values(poi.names),poi.name,poi.address].join(" ")),poi.address,poi.description,JSON.stringify(poi.tags),JSON.stringify(poi.features),poi.categories,JSON.stringify(poi.geometry),poi.openingHours,poi.sourceUpdatedAt,poi.sourceUrl,hasPublicAccess(poi.tags)]);
        for(const category of poi.categories)await client.query("INSERT INTO poi_categories(run_id,poi_id,category_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",[runId,poi.id,category]);
        count++;
      }
      const kind=tags.landuse||(tags.leisure==="park"?"recreation_ground":null);
      if(kind&&["Polygon","MultiPolygon"].includes(f.geometry.type))await client.query(`INSERT INTO import_landuse(run_id,id,kind,geom) VALUES($1,$2,$3,ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($4),4326))) ON CONFLICT DO NOTHING`,[runId,String(f.id),kind,JSON.stringify(f.geometry)]);
      if(String(f.id).startsWith("node/")&&tags.entrance&&tags.entrance!=="no"&&hasPublicAccess(tags)&&f.geometry.type==="Point"){
        await client.query("INSERT INTO import_entrances(run_id,id,geom,tags) VALUES($1,$2,ST_SetSRID(ST_Point($3,$4),4326),$5) ON CONFLICT DO NOTHING",[runId,String(f.id),f.geometry.coordinates[0],f.geometry.coordinates[1],JSON.stringify(tags)]);
      }
    }
    await client.query("UPDATE import_tiles SET status='complete',poi_count=$3,raw_path=$4,error=NULL WHERE run_id=$1 AND id=$2",[runId,tile.id,count,relative(process.cwd(),rawPath)]);
  });
}
async function runImport(forceNew:boolean){
  const pending=forceNew?[]:await query("SELECT id,snapshot_at FROM import_runs WHERE config_version=$1 AND status IN ('collecting','failed','validating') ORDER BY created_at DESC LIMIT 1",[IMPORT_CONFIG]);
  const run=pending.length?{id:String(pending[0].id),snapshot:pending[0].snapshot_at.toISOString().replace(".000Z","Z")}:await newRun();
  console.log(`Импорт ${run.id}, снимок ${run.snapshot}`);
  await query("UPDATE import_runs SET status='collecting',error=NULL WHERE id=$1",[run.id]);
  try{
    while(true){
      const rows=await query("SELECT * FROM import_tiles WHERE run_id=$1 AND status IN ('pending','failed') ORDER BY depth,id LIMIT 1",[run.id]);
      if(!rows.length)break;
      const r=rows[0],tile:Tile={id:r.id,parentId:r.parent_id,depth:r.depth,minX:r.min_x,minY:r.min_y,maxX:r.max_x,maxY:r.max_y};
      const bbox=tileBBox(tile).join(",");
      const ql=`${snapshotPrefix(run.snapshot)}(${poiSelectors(bbox)}\nnwr["landuse"~"^(residential|commercial|retail|industrial|recreation_ground)$"](${bbox});node["entrance"](${bbox}););out meta geom;`;
      const rawPath=resolve(DATA,"raw",run.id,`${tile.id}.json`);
      await query("UPDATE import_tiles SET attempts=attempts+1 WHERE run_id=$1 AND id=$2",[run.id,tile.id]);
      let response:OverpassResponse;
      try{
        response=await requestOverpass(ql,rawPath);
      }catch(error){
        if(tile.depth>=3){await query("UPDATE import_tiles SET status='failed',error=$3 WHERE run_id=$1 AND id=$2",[run.id,tile.id,"Не удалось полностью получить или сохранить квадрат"]);throw error;}
        await transaction(async client=>{
          await client.query("UPDATE import_tiles SET status='split',error=$3 WHERE run_id=$1 AND id=$2",[run.id,tile.id,"Квадрат разделён после ошибки загрузки"]);
          for(const child of splitTile(tile))await insertTile(client,run.id,child);
        });
        console.log(`↳ ${tile.id}: разделён на четыре квадрата`);
        continue;
      }
      await persistResponse(run.id,tile,response,rawPath);
      console.log(`✓ ${tile.id}: ${response.elements.length} OSM-объектов`);
    }
    await query("UPDATE import_runs SET status='validating' WHERE id=$1",[run.id]);
    await finalizeGeometry(run.id);
    await analyzeCoverage(run.id);
    // Empty analytical cells are verified with an independent, POI-only request.
    const empty=await query("SELECT id,ST_AsGeoJSON(geom)::json geometry FROM coverage_cells WHERE run_id=$1 AND (properties->>'count')::int=0",[run.id]);
    for(const cell of empty){
      const bboxRows=await query("SELECT ST_YMin(geom) a,ST_XMin(geom) b,ST_YMax(geom) c,ST_XMax(geom) d FROM coverage_cells WHERE run_id=$1 AND id=$2",[run.id,cell.id]);
      const b=bboxRows[0],bbox=[b.a,b.b,b.c,b.d].join(",");
      const response=await requestOverpass(`${snapshotPrefix(run.snapshot)}(${poiSelectors(bbox)});out meta geom;`,resolve(DATA,"raw",run.id,`verify-${cell.id}.json`));
      const synthetic:Tile={id:`verify-${cell.id}`,parentId:null,depth:0,minX:0,minY:0,maxX:0,maxY:0};
      await persistResponse(run.id,synthetic,response,resolve(DATA,"raw",run.id,`verify-${cell.id}.json`));
      await query("UPDATE coverage_cells SET properties=jsonb_set(properties,'{state}','\"empty_verified\"') WHERE run_id=$1 AND id=$2",[run.id,cell.id]);
    }
    await finalizeGeometry(run.id);
    await analyzeCoverage(run.id,true);
    await transaction(async client=>{
      const incomplete=await client.query("SELECT count(*)::int n FROM import_tiles WHERE run_id=$1 AND status NOT IN ('complete','split')",[run.id]);
      const checks=await client.query("SELECT count(*)::int n FROM coverage_cells WHERE run_id=$1 AND properties->>'state'='needs_check'",[run.id]);
      const count=await client.query("SELECT count(*)::int n FROM poi WHERE run_id=$1 AND duplicate_of IS NULL AND public_access",[run.id]);
      if(incomplete.rows[0].n||checks.rows[0].n||!count.rows[0].n)throw new Error("Импорт не прошёл проверку полноты или пуст");
      await client.query("UPDATE import_runs SET status='published',published_at=now(),error=NULL WHERE id=$1",[run.id]);
      await client.query("UPDATE dataset_state SET active_run_id=$1 WHERE singleton",[run.id]);
    });
    console.log("Новая версия датасета опубликована атомарно.");
  }catch(error){await query("UPDATE import_runs SET status='failed',error=$2 WHERE id=$1",[run.id,error instanceof Error?error.message.slice(0,500):"Ошибка импорта"]);throw error;}
}
export async function withCollectionLock<T>(work:()=>Promise<T>):Promise<T>{
  await mkdir(resolve(DATA,"state"),{recursive:true});
  const lockPath=resolve(DATA,"state","collect.lock");
  let handle;
  try{handle=await open(lockPath,"wx");await handle.writeFile(String(process.pid));}
  catch(error){
    if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;
    const pid=Number(await readFile(lockPath,"utf8"));
    if(!Number.isSafeInteger(pid)||pid<=0)throw new Error("Некорректный файл блокировки data/state/collect.lock");
    try{process.kill(pid,0);throw new Error("Сборщик уже запущен.");}
    catch(check){if((check as NodeJS.ErrnoException).code!=="ESRCH")throw check;}
    await unlink(lockPath);handle=await open(lockPath,"wx");await handle.writeFile(String(process.pid));
  }
  try{return await work();}finally{await handle.close();await unlink(lockPath);}
}
export async function collect(forceNew=false){return withCollectionLock(()=>runImport(forceNew));}

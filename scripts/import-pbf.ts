import "./env";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir,readFile,writeFile,unlink } from "node:fs/promises";
import { resolve,dirname,basename } from "node:path";
import { spawn } from "node:child_process";
import type { Feature,Geometry,MultiPolygon,Polygon } from "geojson";
import { CATEGORIES,CATEGORY_IDS } from "../src/lib/catalog";
import { closeDb,query,transaction } from "../src/server/db";
import { createImportRun,persistFeatures,withCollectionLock } from "../src/data/collector";
import { finalizeGeometry,analyzeCoverage,auditData } from "../src/data/coverage";

async function main(){
  const source=resolve(process.argv.find(a=>a.startsWith("--file="))?.slice(7)??"data/raw/kazakhstan-latest.osm.pbf");
  const python=process.env.OSM_PYTHON||(process.platform==="win32"?resolve(".local/osm-tools/Scripts/python.exe"):resolve(".local/osm-tools/bin/python"));
  await mkdir("data/raw",{recursive:true});
  const catalog=resolve("data/raw/pbf-catalog.json"),output=resolve("data/raw/astana-pbf.json");
  const catalogText=JSON.stringify({boundaryRelationId:process.env.ASTANA_BOUNDARY_RELATION_ID||"3087156",rules:CATEGORY_IDS.flatMap(id=>CATEGORIES[id].rules)});
  await writeFile(catalog,catalogText);
  const hash=createHash("sha256");for await(const chunk of createReadStream(source))hash.update(chunk);const sha=hash.digest("hex");
  const manifestPath=resolve("data/raw/astana-pbf-manifest.json");
  const fingerprint=createHash("sha256").update(sha).update(catalogText).update(await readFile("scripts/extract-pbf.py")).digest("hex");
  let previous:{fingerprint?:string}={};try{previous=JSON.parse(await readFile(manifestPath,"utf8"));}catch{}
  if(previous.fingerprint!==fingerprint){
    await new Promise<void>((done,fail)=>{
      const child=spawn(python,["scripts/extract-pbf.py",source,catalog,output],{stdio:"inherit",windowsHide:true});
      child.on("error",()=>fail(new Error("Не найден Python с osmium. Установите scripts/osm-requirements.txt в виртуальное окружение .local/osm-tools.")));
      child.on("exit",code=>code===0?done():fail(new Error("PBF не прошёл полное извлечение; версия не опубликована.")));
    });
    await writeFile(manifestPath,JSON.stringify({sha,fingerprint,source}));
  }
  const data=JSON.parse(await readFile(output,"utf8")) as {metadata:{snapshot:string;completeExtract:boolean;temporaryIndexes?:string[]};boundary:Feature<Polygon|MultiPolygon>;features:Feature<Geometry>[]};
  for(const file of data.metadata.temporaryIndexes??[]){
    const target=resolve(file);
    if(dirname(target)===resolve(".local")&&/^(boundary|object)-nodes-\d+\.idx$/.test(basename(target)))try{await unlink(target);}catch{}
  }
  if(!data.metadata.completeExtract||!data.features.length)throw new Error("Нет полного подготовленного снимка");
  const configVersion=`pbf-v2:${fingerprint}`;
  const pending=await query("SELECT id FROM import_runs WHERE config_version=$1 AND status IN ('collecting','validating','failed') ORDER BY created_at DESC LIMIT 1",[configVersion]);
  const id=pending.length?String(pending[0].id):await createImportRun({feature:data.boundary,relationId:String(data.boundary.id).split("/")[1]},data.metadata.snapshot,configVersion);
  await query("UPDATE import_runs SET config_version=$2,status='collecting',error=NULL WHERE id=$1",[id,configVersion]);
  try{
    for(let offset=0;offset<data.features.length;offset+=200){
      await persistFeatures(id,{id:"pbf-batch",parentId:null,depth:0,minX:0,minY:0,maxX:0,maxY:0},data.features.slice(offset,offset+200),output);
      console.log(`Сохранено ${Math.min(offset+200,data.features.length)}/${data.features.length}`);
    }
    await finalizeGeometry(id);
    await query("UPDATE import_tiles SET status='complete',raw_path=$2,empty_verified=true,poi_count=0 WHERE run_id=$1",[id,output]);
    await query("UPDATE import_runs SET status='validating' WHERE id=$1",[id]);
    await analyzeCoverage(id);
    // The complete country file was read to EOF with all references assembled.
    // Independently re-count each cell instead of contacting the failing API.
    await query(`UPDATE coverage_cells c SET properties=jsonb_set(jsonb_set(properties,'{state}','\"empty_verified\"'),'{verification}','\"complete_pbf_snapshot\"')
      WHERE c.run_id=$1 AND (c.properties->>'count')::int=0
        AND NOT EXISTS(SELECT 1 FROM poi p WHERE p.run_id=c.run_id AND p.public_access AND p.duplicate_of IS NULL AND ST_Covers(c.geom,p.display_point))`,[id]);
    const audit=await auditData(id);if(!audit.passed)throw new Error("Снимок не прошёл проверку покрытия");
    await transaction(async client=>{await client.query("UPDATE import_runs SET status='published',published_at=now(),error=NULL WHERE id=$1",[id]);await client.query("UPDATE dataset_state SET active_run_id=$1 WHERE singleton",[id]);});
    console.log(`Опубликован полный OSM-снимок: ${audit.counts.usable} мест, версия ${id}`);
  }catch(error){await query("UPDATE import_runs SET status='failed',error=$2 WHERE id=$1",[id,"Ошибка обработки PBF-снимка"]);throw error;}
}
withCollectionLock(main).catch((e:Error)=>{console.error(e.message);process.exitCode=1;}).finally(closeDb);

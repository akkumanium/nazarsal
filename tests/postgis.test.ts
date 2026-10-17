import { beforeAll,afterAll,describe,expect,it,vi } from "vitest";
import { readFile,readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { postgis } from "@electric-sql/pglite-postgis";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { setFlagsFromString } from "node:v8";
import type { Feature,Polygon } from "geojson";
const state=vi.hoisted(()=>({database:null as PGlite|null}));
vi.mock("@/server/db",()=>({
  query:async(text:string,values:unknown[]=[])=>{return (await state.database!.query(text,values)).rows;},
  transaction:async(work:(client:unknown)=>Promise<unknown>)=>state.database!.transaction(work),
  ConfigurationError:class ConfigurationError extends Error{}
}));
import { createImportRun,persistResponse } from "../src/data/collector";
import { finalizeGeometry,analyzeCoverage,auditData } from "../src/data/coverage";
import { findCandidates } from "../src/server/candidate-search";
import { activeVersion,searchPlaces,getCoverage } from "../src/server/repository";
import { intent } from "./fixtures";

let version:string;
const boundary:Feature<Polygon>={type:"Feature",geometry:{type:"Polygon",coordinates:[[[71.42,51.12],[71.45,51.12],[71.45,51.14],[71.42,51.14],[71.42,51.12]]]},properties:{}};
beforeAll(async()=>{
  setFlagsFromString("--wasm-num-compilation-tasks=1 --liftoff-only");
  state.database=new PGlite({extensions:{postgis,pg_trgm}});
  await state.database.waitReady;
  for(const file of (await readdir("db/migrations")).filter(f=>f.endsWith(".sql")).sort())await state.database.exec(await readFile(`db/migrations/${file}`,"utf8"));
  version=await createImportRun({feature:boundary,relationId:"999"},"2026-10-17T00:00:00Z");
  await persistResponse(version,{id:"test",parentId:null,depth:0,minX:0,minY:0,maxX:1,maxY:1},{elements:[
    {type:"node",id:1,lat:51.1282,lon:71.4304,tags:{amenity:"cafe",name:"Тестовый кофе",opening_hours:"24/7","service:electricity":"yes"}},
    {type:"node",id:2,lat:51.129,lon:71.434,tags:{leisure:"playground"}},
    {type:"node",id:3,lat:51.129,lon:71.435,tags:{tourism:"museum",name:"Тестовый музей",opening_hours:"24/7"}},
    {type:"node",id:4,lat:51.129,lon:71.436,tags:{amenity:"cafe",name:"Тестовый кофе",access:"private"}},
    {type:"node",id:5,lat:52,lon:72,tags:{amenity:"cafe",name:"Вне границы"}},
    {type:"node",id:8,lat:51.129,lon:71.434,tags:{amenity:"cafe"}},
    {type:"node",id:9,lat:51.129,lon:71.435,tags:{leisure:"trampoline_park"}},
    {type:"node",id:10,lat:51.129,lon:71.436,tags:{leisure:"playground",access:"private"}},
    {type:"way",id:6,tags:{leisure:"park",name:"Тестовый парк"},geometry:[{lat:51.13,lon:71.43},{lat:51.13,lon:71.44},{lat:51.135,lon:71.44},{lat:51.135,lon:71.43},{lat:51.13,lon:71.43}]},
    {type:"way",id:7,tags:{amenity:"cafe",name:"Тестовый кофе"},geometry:[{lat:51.1281,lon:71.4303},{lat:51.1281,lon:71.4305},{lat:51.1283,lon:71.4305},{lat:51.1283,lon:71.4303},{lat:51.1281,lon:71.4303}]}
  ]},"data/raw/test.json");
  await finalizeGeometry(version);
},60000);
afterAll(async()=>{await state.database?.close();},30000);

describe("real PostgreSQL + PostGIS pipeline",()=>{
  it("imports geometry, keeps unnamed objects, excludes outside-city objects",async()=>{
    const rows=await state.database!.query<{id:string;named:boolean;inside:boolean}>("SELECT p.id,p.named,ST_Covers(r.boundary,p.display_point) inside FROM poi p JOIN import_runs r ON r.id=p.run_id ORDER BY p.id");
    expect(rows.rows.some(p=>p.id==="node/2"&&!p.named)).toBe(true);
    expect(rows.rows.some(p=>p.id==="node/5")).toBe(false);
    expect(rows.rows.every(p=>p.inside)).toBe(true);
  });
  it("keeps an unpublished version invisible and switches atomically",async()=>{
    expect(await activeVersion()).toBeNull();
    await state.database!.transaction(async tx=>{
      await tx.query("UPDATE import_runs SET status='published',published_at=now() WHERE id=$1",[version]);
      await tx.query("UPDATE dataset_state SET active_run_id=$1",[version]);
    });
    expect(await activeVersion()).toBe(version);
  });
  it("executes indexed spatial search, excludes private venues and honours mandatory features",async()=>{
    const found=await findCandidates(intent({constraints:[{feature:"power_outlets",operator:"eq",value:true,strength:"must"}]}),{lat:51.1282,lon:71.4304},1500,version,[],new Date("2026-10-17T12:00:00+05:00"));
    expect(found.map(p=>p.id)).toEqual(["way/7"]);expect(found[0].distanceMeters).toBeLessThan(1);
    expect(found[0].features.power_outlets.sourceElementIds).toContain("node/1");
    expect(found[0].openingHours).toBe("24/7");expect(found[0].sourceIds).toContain("node/1");
  });
  it("supports OR-category groups and explicit exclusion",async()=>{
    const found=await findCandidates(intent({goals:[{categoryIds:["museum","park"],priority:"primary",required:true}],excludedCategoryIds:["museum"]}),{lat:51.1282,lon:71.4304},1500,version,[],new Date("2026-10-17T12:00:00+05:00"));
    expect(found.map(p=>p.id)).toEqual(["way/6"]);
  });
  it("recommends unnamed public playgrounds without admitting other unnamed venues",async()=>{
    const origin={lat:51.1282,lon:71.4304},start=new Date("2026-10-17T12:00:00+05:00");
    const children=intent({goals:[{categoryIds:["children"],priority:"primary",required:true}]});
    const found=await findCandidates(children,origin,1500,version,[],start);
    expect(found.map(p=>p.id)).toEqual(["node/2"]);
    expect(found[0].named).toBe(false);
    expect(found[0].tags.leisure).toBe("playground");
    expect(await findCandidates(children,origin,1500,version,["node/2"],start)).toEqual([]);
    expect(await findCandidates({...children,excludedCategoryIds:["children"]},origin,1500,version,[],start)).toEqual([]);
    expect(await findCandidates({...children,constraints:[{feature:"free_entry",operator:"eq",value:true,strength:"must"}]},origin,1500,version,[],start)).toEqual([]);
    const coffee=await findCandidates(intent(),origin,1500,version,[],start);
    expect(coffee.map(p=>p.id)).toEqual(["way/7"]);
  });
  it("resolves a named origin from the actual database",async()=>{
    const found=await searchPlaces("Тестовый кофе",version);expect(found[0].id).toBe("way/7");
    expect(found.some(p=>["node/4","node/5"].includes(p.id))).toBe(false);
    expect(found[0].matchScore-found[1].matchScore).toBeGreaterThan(.35);
  });
  it("creates coverage cells without treating unchecked empty cells as complete",async()=>{
    await analyzeCoverage(version);
    const coverage=await getCoverage();expect(coverage.features.length).toBeGreaterThan(0);
    expect(coverage.features.some(f=>f.properties.count>0)).toBe(true);
    expect(coverage.features.filter(f=>f.properties.count===0).every(f=>f.properties.state==="needs_check")).toBe(true);
    const report=await auditData(version);expect(report.counts.usable).toBe(6);
    expect(report.passed).toBe(false);
  });
});

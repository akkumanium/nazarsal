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
import { COMMUNITY_COOKIE, acceptFriendInvite, commentPlaces, communityBudget, communityProfileSummary, createCommunitySession, createFriendInvite, currentProfile, deleteMapComment, listMapComments, publishMapComment, removeCommunityFriend, updateCommunityProfileName } from "../src/server/comments";

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

describe("map comments with real SQL and privacy checks",()=>{
  const bounds={west:71.42,south:51.12,east:71.45,north:51.14};
  it("saves the profile name and returns real statistics for the session owner",async()=>{
    const {profile,token}=await createCommunitySession(), other=(await createCommunitySession()).profile;
    const id=await publishMapComment(profile,{poiId:"way/7",text:"My profile comment",lifetimeHours:1,visibility:"public"});
    const updated=await updateCommunityProfileName(profile,"Аружан");
    expect(updated).toEqual({id:profile.id,name:"Аружан"});
    expect((await listMapComments(bounds,null)).find(comment=>comment.id===id)?.author.name).toBe("Аружан");
    expect(await currentProfile(new Request("http://localhost",{headers:{cookie:`${COMMUNITY_COOKIE}=${token}`}}))).toEqual(updated);
    expect(await communityProfileSummary(updated)).toMatchObject({activeComments:1,friendsCount:0});
    expect(await communityProfileSummary(other)).toMatchObject({activeComments:0,friendsCount:0});
  });
  it("lists only existing public places and rejects arbitrary or private POIs",async()=>{
    const {profile}=await createCommunitySession();
    const places=await commentPlaces(bounds);
    expect(places.places.some(place=>place.id==="way/7")).toBe(true);
    expect(places.places.some(place=>place.id==="node/4")).toBe(false);
    for(const poiId of ["node/99999999","node/4"]){
      await expect(publishMapComment(profile,{poiId,text:"Closed today",lifetimeHours:1,visibility:"public"})).rejects.toThrow("существующее место");
    }
  });
  it("uses an opaque cookie for identity and rejects a profile ID as a credential",async()=>{
    const {profile,token}=await createCommunitySession();
    const request=(value:string)=>new Request("http://localhost/api/comments",{headers:{cookie:`${COMMUNITY_COOKIE}=${value}`}});
    expect(await currentProfile(request(token))).toEqual(profile);
    expect(await currentProfile(request(profile.id))).toBeNull();
    expect(await currentProfile(request("a".repeat(43)))).toBeNull();
  });
  it("hides friends-only comments until a single-use invitation is accepted, and revokes access",async()=>{
    const author=(await createCommunitySession()).profile,friend=(await createCommunitySession()).profile,stranger=(await createCommunitySession()).profile;
    const id=await publishMapComment(author,{poiId:"way/7",text:"Private entrance tip",lifetimeHours:6,visibility:"friends"});
    expect((await listMapComments(bounds,null)).some(comment=>comment.id===id)).toBe(false);
    expect((await listMapComments(bounds,stranger)).some(comment=>comment.id===id)).toBe(false);
    expect((await listMapComments(bounds,author)).find(comment=>comment.id===id)?.canDelete).toBe(true);
    const code=await createFriendInvite(author);
    await expect(acceptFriendInvite(author,code)).rejects.toThrow("недействителен");
    await acceptFriendInvite(friend,code);
    expect((await listMapComments(bounds,friend)).find(comment=>comment.id===id)?.canDelete).toBe(false);
    await expect(acceptFriendInvite(stranger,code)).rejects.toThrow("недействителен");
    await removeCommunityFriend(author,friend.id);
    expect((await listMapComments(bounds,friend)).some(comment=>comment.id===id)).toBe(false);
  });
  it("computes expiry on the server and omits expired comments, including for their author",async()=>{
    const {profile}=await createCommunitySession();
    const id=await publishMapComment(profile,{poiId:"way/7",text:"Public note",lifetimeHours:1,visibility:"public"});
    const row=(await listMapComments(bounds,null)).find(comment=>comment.id===id)!;
    expect(Date.parse(row.expiresAt)-Date.parse(row.createdAt)).toBe(3600000);
    expect(row.place.point.lat).toBeCloseTo(51.1282,3);
    await state.database!.query("UPDATE map_comments SET created_at=now()-interval '2 hours',expires_at=now()-interval '1 hour' WHERE id=$1",[id]);
    expect((await listMapComments(bounds,profile)).some(comment=>comment.id===id)).toBe(false);
  });
  it("only lets the author delete a comment",async()=>{
    const author=(await createCommunitySession()).profile,other=(await createCommunitySession()).profile;
    const id=await publishMapComment(author,{poiId:"way/7",text:"An honest tip",lifetimeHours:24,visibility:"public"});
    await expect(deleteMapComment(other,id)).rejects.toThrow("другому пользователю");
    expect((await listMapComments(bounds,null)).some(comment=>comment.id===id)).toBe(true);
    await deleteMapComment(author,id);
    expect((await listMapComments(bounds,null)).some(comment=>comment.id===id)).toBe(false);
  });
  it("enforces write budgets atomically in the database",async()=>{
    await communityBudget("test-limit",1);
    await expect(communityBudget("test-limit",1)).rejects.toThrow("Слишком много");
  });
});

import { describe,expect,it } from "vitest";
import { candidate,intent,matrix } from "./fixtures";
import { extractFeatures,normalizeOsmFeature,hasPublicAccess } from "../src/lib/poi-normalizer";
import { intentSchema,withDefaults } from "../src/lib/intent";
import { fitsMust,searchRadii,selectDiverseCandidates } from "../src/server/candidate-search";
import { openingState } from "../src/server/opening-hours";
import { enumeratePlans,evaluateSequence,revalidateDirections } from "../src/server/route-planner";
import { splitTile,tileBBox } from "../src/data/grid";
import { parseOverpass,retryDelay } from "../src/data/overpass";
import { mergeEvidence } from "../src/data/merge-evidence";

const start=new Date("2026-10-17T12:00:00+05:00");
describe("OSM normalisation and unknown evidence",()=>{
  it("keeps an unnamed playground without inventing a proper name",()=>{
    const p=normalizeOsmFeature({type:"Feature",id:"node/10",geometry:{type:"Point",coordinates:[71.43,51.12]},properties:{tags:{leisure:"playground"}}});
    expect(p?.named).toBe(false);expect(p?.categories).toEqual(["children"]);expect(p?.name).toBe("Детская активность");
  });
  it("distinguishes electricity availability from limitations and nearby chargers",()=>{
    expect(extractFeatures({amenity:"cafe","service:electricity":"yes"}).power_outlets.value).toBe(true);
    expect(extractFeatures({amenity:"cafe","service:electricity":"ask"}).power_outlets.value).toBe("ask");
    expect(extractFeatures({amenity:"cafe","socket:schuko":"2"}).power_outlets.value).toBe(true);
    expect(extractFeatures({amenity:"charging_station","socket:schuko":"2"}).power_outlets.value).toBeNull();
  });
  it("does not infer indoors from covered or quiet/child-friendly from museum",()=>{
    const f=extractFeatures({tourism:"museum",covered:"yes"});
    expect(f.indoor.value).toBeNull();expect(f.quiet.value).toBeNull();expect(f.child_friendly.value).toBeNull();
  });
  it("excludes known private and disused facilities",()=>{expect(hasPublicAccess({access:"private"})).toBe(false);expect(hasPublicAccess({disused:"yes"})).toBe(false);});
  it("does not silently satisfy a mandatory socket requirement with unknown",()=>{
    const i=intent({constraints:[{feature:"power_outlets",operator:"eq",value:true,strength:"must"}]});
    expect(fitsMust(candidate("1"),i)).toBe(false);
    expect(fitsMust(candidate("2","coffee",{features:extractFeatures({"service:electricity":"yes"})}),i)).toBe(true);
  });
  it("preserves evidence from a duplicate representation and does not hide conflicts",()=>{
    const merged=mergeEvidence([{id:"way/1",tags:{amenity:"cafe"}},{id:"node/2",tags:{"service:electricity":"yes",opening_hours:"24/7"}}]);
    expect(merged.features.power_outlets.value).toBe(true);expect(merged.features.power_outlets.sourceElementIds).toEqual(["node/2"]);expect(merged.openingHours).toBe("24/7");
    const conflict=mergeEvidence([{id:"way/1",tags:{"service:electricity":"yes",opening_hours:"24/7"}},{id:"node/2",tags:{"service:electricity":"no",opening_hours:"Mo-Fr 10:00-18:00"}},{id:"node/3",tags:{"service:electricity":"yes"}}]);
    expect(conflict.features.power_outlets.value).toBeNull();expect(conflict.features.power_outlets.basis).toBe("unknown");expect(conflict.openingHours).toBeNull();
    const privateVenue=mergeEvidence([{id:"way/1",tags:{name:"Кафе"}},{id:"node/2",tags:{access:"private","name:en":"Cafe"}}]);
    expect(privateVenue.publicAccess).toBe(false);expect(privateVenue.names["name:en"]).toBe("Cafe");
  });
});
describe("intent and candidate pool",()=>{
  it("rejects invented categories, flags contradictory required goals",()=>{
    expect(intentSchema.safeParse({...intent(),excludedCategoryIds:["secret_rooftop"]}).success).toBe(false);
    expect(withDefaults(intent({excludedCategoryIds:["coffee"]})).clarification).toBeTruthy();
  });
  it("preserves a rare required category among many cafes",()=>{
    const cafes=Array.from({length:50},(_,i)=>candidate(String(i)));
    const park=candidate("100","park",{score:.1});
    const i=intent({goals:[{categoryIds:["coffee"],priority:"primary",required:true},{categoryIds:["park"],priority:"primary",required:true}]});
    expect(selectDiverseCandidates([...cafes,park],i).some(p=>p.id===park.id)).toBe(true);
  });
  it("respects the radius cap and tight round-trip budgets",()=>{
    expect(searchRadii(intent({maxRadiusMeters:400}))).toEqual([400]);
    expect(Math.max(...searchRadii(intent({durationMinutes:10,returnToStart:true})))).toBeLessThanOrEqual(250);
  });
  it("avoids repeated representations of a parent venue while keeping a cafe inside it",()=>{
    const mall=candidate("1","mall"),label=candidate("2","mall",{parentPoiId:mall.id}),cafe=candidate("3","coffee",{parentPoiId:mall.id});
    const selected=selectDiverseCandidates([mall,label,cafe],intent({goals:[{categoryIds:["mall"],priority:"primary",required:false},{categoryIds:["coffee"],priority:"primary",required:false}]}));
    expect(selected.map(p=>p.id)).toEqual([mall.id,cafe.id]);
  });
});
describe("schedule evaluation",()=>{
  it("checks the full visit, not just arrival",()=>{
    const p=candidate("1","coffee",{openingHours:"Sa 12:00-12:30"});
    expect(openingState(p,start,new Date("2026-10-17T12:20:00+05:00"))).toBe("open_by_schedule");
    expect(openingState(p,start,new Date("2026-10-17T12:40:00+05:00"))).toBe("closed_by_schedule");
  });
  it("handles crossing midnight in Astana regardless of host timezone",()=>{
    const p=candidate("1","coffee",{openingHours:"Sa 22:00-02:00"});
    expect(openingState(p,new Date("2026-10-17T23:30:00+05:00"),new Date("2026-10-18T01:00:00+05:00"))).toBe("open_by_schedule");
  });
  it("leaves missing, broken and unsupported holidays unknown",()=>{
    for(const rule of [null,"PH off; Mo-Su 10:00-20:00","not a valid schedule"])
      expect(openingState(candidate("1","park",{openingHours:rule}),start,new Date(start.getTime()+600000))).toBe("unknown");
  });
});
describe("route feasibility",()=>{
  it("honours directed return travel and reserve",()=>{
    const m=matrix(2);m.durations[1][0]=2400;
    expect(evaluateSequence([0],[candidate("1")],m,intent({returnToStart:true,durationMinutes:60}),start)).toBeNull();
    m.durations[1][0]=600;
    const p=evaluateSequence([0],[candidate("1")],m,intent({returnToStart:true}),start)!;
    expect(p.walkingMinutes).toBe(15);expect(p.totalMinutes).toBe(36);expect(p.legs[1].toId).toBe("origin");
  });
  it("keeps AND goals in order and OR in one group",()=>{
    const points=[candidate("1","coffee"),candidate("2","park")],m=matrix(3);
    const and=intent({goals:[{categoryIds:["coffee"],priority:"primary",required:true},{categoryIds:["park"],priority:"primary",required:true}]});
    expect(evaluateSequence([0],points,m,and,start)).toBeNull();expect(evaluateSequence([1,0],points,m,and,start)).toBeNull();expect(evaluateSequence([0,1],points,m,and,start)).not.toBeNull();
    const or=intent({mode:"alternatives",goals:[{categoryIds:["museum","park"],priority:"primary",required:true}]});
    expect(evaluateSequence([1],points,m,or,start)).not.toBeNull();
  });
  it("does not shrink a museum visit or traverse a missing route",()=>{
    expect(enumeratePlans([candidate("1","museum")],matrix(2),intent({durationMinutes:30,goals:[{categoryIds:["museum"],priority:"primary",required:true}]}),start)).toHaveLength(0);
    const m=matrix(2);m.durations[0][1]=null;expect(enumeratePlans([candidate("1")],m,intent(),start)).toHaveLength(0);
  });
  it("allows distinct activities inside a parent park, and requires separate ordered stops",()=>{
    const playground=candidate("1","children",{parentPoiId:"node/2"}),park=candidate("2","park");
    const i=intent({durationMinutes:90,goals:[{categoryIds:["children"],priority:"primary",required:true},{categoryIds:["park"],priority:"primary",required:true}]});
    expect(evaluateSequence([0,1],[playground,park],matrix(3),i,start)).not.toBeNull();
    const combined=candidate("3","children",{categories:["children","park"]});
    expect(evaluateSequence([0],[combined],matrix(2),i,start)).toBeNull();
  });
  it("does not claim open-only with an unknown schedule",()=>{
    expect(evaluateSequence([0],[candidate("1","coffee",{openingHours:null})],matrix(2),intent({constraints:[{feature:"open_now",operator:"eq",value:true,strength:"must"}]}),start)).toBeNull();
  });
  it("rejects a Directions result that makes the route exceed its budget",()=>{
    const c=[candidate("1")],i=intent({durationMinutes:30}),p=evaluateSequence([0],c,matrix(2),i,start)!;
    expect(revalidateDirections(p,{geometry:{type:"LineString",coordinates:[[71.43,51.12],[71.44,51.12]]},segments:[{duration:1200,distance:1700}]},c,i,start)).toBeNull();
  });
});
describe("collector integrity",()=>{
  it("does not accept partial Overpass responses as empty success",()=>{
    expect(()=>parseOverpass({elements:[],remark:"runtime error: Query timed out"})).toThrow();
    expect(()=>parseOverpass({})).toThrow();expect(parseOverpass({elements:[]}).elements).toEqual([]);
  });
  it("supports numeric and HTTP-date retry-after",()=>{
    expect(retryDelay("3")).toBe(3000);expect(retryDelay("Wed, 01 Jan 2025 00:00:05 GMT",Date.parse("2025-01-01T00:00:00Z"))).toBe(5000);
  });
  it("subdivides with no gaps and converts metre grids to Astana coordinates",()=>{
    const t={id:"a",parentId:null,depth:0,minX:650000,minY:5660000,maxX:655000,maxY:5665000},children=splitTile(t);
    expect(children).toHaveLength(4);expect(children.reduce((s,c)=>s+(c.maxX-c.minX)*(c.maxY-c.minY),0)).toBe(25000000);
    const bbox=tileBBox(t);expect(bbox[0]).toBeGreaterThan(50);expect(bbox[1]).toBeGreaterThan(70);expect(bbox[2]).toBeGreaterThan(bbox[0]);
  });
});

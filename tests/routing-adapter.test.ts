import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
const database=vi.hoisted(()=>({query:vi.fn()}));
vi.mock("@/server/db",()=>({query:database.query,ConfigurationError:class ConfigurationError extends Error{}}));
import { walkingMatrix,walkingDirections } from "../src/server/routing";
beforeEach(()=>{vi.stubEnv("ORS_API_KEY","test-only-key");database.query.mockReset();database.query.mockResolvedValue([]);});
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});
describe("openrouteservice adapter",()=>{
  it("requests instructions so ORS includes the per-leg durations needed by planning",async()=>{
    const fetcher=vi.fn().mockImplementation((_url,options)=>{
      const body=JSON.parse(options.body);
      return Response.json({features:[{geometry:{type:"LineString",coordinates:body.coordinates},properties:{
        ...(body.instructions?{segments:[{duration:300,distance:400}]}:{}),way_points:[0,1]
      }}]});
    });
    vi.stubGlobal("fetch",fetcher);
    const result=await walkingDirections([{lat:51.12,lon:71.43},{lat:51.13,lon:71.44}]);
    expect(result.segments).toEqual([{duration:300,distance:400}]);
  });
  it("requests one directed matrix and never persists GPS origins",async()=>{
    const fetcher=vi.fn().mockResolvedValue(Response.json({durations:[[0,300],[500,0]],distances:[[0,400],[650,0]]}));vi.stubGlobal("fetch",fetcher);
    const result=await walkingMatrix({lat:51.12,lon:71.43},[{lat:51.13,lon:71.44}],["node/1"],"test-version");
    expect(result.durations[1][0]).toBe(500);expect(fetcher).toHaveBeenCalledTimes(1);expect(database.query).not.toHaveBeenCalled();
    expect(JSON.parse(fetcher.mock.calls[0][1].body).locations).toEqual([[71.43,51.12],[71.44,51.13]]);
  });
  it("preserves unreachable edges instead of estimating them",async()=>{
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(Response.json({durations:[[0,null],[null,0]],distances:[[0,null],[null,0]]})));
    expect((await walkingMatrix({lat:51.12,lon:71.43},[{lat:51.13,lon:71.44}],["node/1"],"test-version")).durations[0][1]).toBeNull();
  });
  it("rejects a malformed matrix and does not retry 429 as an estimated route",async()=>{
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(Response.json({durations:[[0]],distances:[[0]]})));
    await expect(walkingMatrix({lat:51.12,lon:71.43},[{lat:51.13,lon:71.44}],["node/1"],"test-version")).rejects.toThrow();
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response("limit",{status:429})));
    await expect(walkingMatrix({lat:51.12,lon:71.43},[],[],"test-version")).rejects.toThrow("Лимит");
  });
  it("verifies every snapped waypoint, not just route distance",async()=>{
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(Response.json({features:[{geometry:{type:"LineString",coordinates:[[71.43,51.12],[71.8,51.4]]},properties:{segments:[{duration:300,distance:400}],way_points:[0,1]}}]})));
    await expect(walkingDirections([{lat:51.12,lon:71.43},{lat:51.13,lon:71.44}])).rejects.toThrow("подход");
  });
});

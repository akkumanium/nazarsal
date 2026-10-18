import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
const database=vi.hoisted(()=>({query:vi.fn()}));
vi.mock("@/server/db",()=>({query:database.query,ConfigurationError:class ConfigurationError extends Error{}}));
import { routeMatrix,routeDirections } from "../src/server/routing";
beforeEach(()=>{vi.stubEnv("ROUTING_PROVIDER","ors");vi.stubEnv("ORS_API_KEY","test-only-key");database.query.mockReset();database.query.mockResolvedValue([]);});
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});
describe("openrouteservice adapter",()=>{
  it("uses the driving profile for both matrix and directions",async()=>{
    const points=[{lat:51.12,lon:71.43},{lat:51.13,lon:71.44}];
    const fetcher=vi.fn().mockResolvedValueOnce(Response.json({durations:[[0,90],[100,0]],distances:[[0,900],[1000,0]]}))
      .mockResolvedValueOnce(Response.json({features:[{geometry:{type:"LineString",coordinates:[[71.43,51.12],[71.44,51.13]]},properties:{segments:[{duration:90,distance:900}],way_points:[0,1]}}]}));
    vi.stubGlobal("fetch",fetcher);
    expect((await routeMatrix(points[0],[points[1]],["node/1"],"version",undefined,"drive")).durations[0][1]).toBe(90);
    expect((await routeDirections(points,120,"drive")).segments[0].duration).toBe(90);
    expect(fetcher.mock.calls[0][0]).toContain("matrix/driving-car");
    expect(fetcher.mock.calls[1][0]).toContain("directions/driving-car/geojson");
  });
  it("distinguishes timeout from denied access",async()=>{
    vi.stubGlobal("fetch",vi.fn().mockRejectedValue(new DOMException("timeout","TimeoutError")));
    await expect(routeMatrix({lat:51.12,lon:71.43},[],[],"test-version")).rejects.toThrow("не ответил за 12 секунд");
    for(const status of [401,403]){
      vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response("denied",{status})));
      await expect(routeMatrix({lat:51.12,lon:71.43},[],[],"test-version")).rejects.toThrow("ORS_API_KEY");
    }
  });
  it("requests instructions so ORS includes the per-leg durations needed by planning",async()=>{
    const fetcher=vi.fn().mockImplementation((_url,options)=>{
      const body=JSON.parse(options.body);
      return Response.json({features:[{geometry:{type:"LineString",coordinates:body.coordinates},properties:{
        ...(body.instructions?{segments:[{duration:300,distance:400}]}:{}),way_points:[0,1]
      }}]});
    });
    vi.stubGlobal("fetch",fetcher);
    const result=await routeDirections([{lat:51.12,lon:71.43},{lat:51.13,lon:71.44}]);
    expect(result.segments).toEqual([{duration:300,distance:400}]);
  });
  it("requests one directed matrix and never persists GPS origins",async()=>{
    const fetcher=vi.fn().mockResolvedValue(Response.json({durations:[[0,300],[500,0]],distances:[[0,400],[650,0]]}));vi.stubGlobal("fetch",fetcher);
    const result=await routeMatrix({lat:51.12,lon:71.43},[{lat:51.13,lon:71.44}],["node/1"],"test-version");
    expect(result.durations[1][0]).toBe(500);expect(fetcher).toHaveBeenCalledTimes(1);expect(database.query).not.toHaveBeenCalled();
    expect(JSON.parse(fetcher.mock.calls[0][1].body).locations).toEqual([[71.43,51.12],[71.44,51.13]]);
  });
  it("preserves unreachable edges instead of estimating them",async()=>{
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(Response.json({durations:[[0,null],[null,0]],distances:[[0,null],[null,0]]})));
    expect((await routeMatrix({lat:51.12,lon:71.43},[{lat:51.13,lon:71.44}],["node/1"],"test-version")).durations[0][1]).toBeNull();
  });
  it("rejects a malformed matrix and does not retry 429 as an estimated route",async()=>{
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(Response.json({durations:[[0]],distances:[[0]]})));
    await expect(routeMatrix({lat:51.12,lon:71.43},[{lat:51.13,lon:71.44}],["node/1"],"test-version")).rejects.toThrow();
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response("limit",{status:429})));
    await expect(routeMatrix({lat:51.12,lon:71.43},[],[],"test-version")).rejects.toThrow("Лимит");
  });
  it("verifies every snapped waypoint, not just route distance",async()=>{
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(Response.json({features:[{geometry:{type:"LineString",coordinates:[[71.43,51.12],[71.8,51.4]]},properties:{segments:[{duration:300,distance:400}],way_points:[0,1]}}]})));
    await expect(routeDirections([{lat:51.12,lon:71.43},{lat:51.13,lon:71.44}])).rejects.toThrow("подход");
  });
});

describe("Geoapify adapter",()=>{
  const points=[{lat:51.12,lon:71.43},{lat:51.13,lon:71.44},{lat:51.14,lon:71.45}];
  const matrix=()=>({sources_to_targets:[
    [{source_index:0,target_index:0,time:0,distance:0},{source_index:0,target_index:1,time:300,distance:400}],
    [{source_index:1,target_index:0,time:500,distance:650},{source_index:1,target_index:1,time:0,distance:0}]
  ]});
  const route=()=>({features:[{geometry:{type:"MultiLineString",coordinates:[
    [[71.43,51.12],[71.44,51.13]],[[71.44,51.13],[71.45,51.14]]
  ]},properties:{legs:[{time:300,distance:400},{time:200,distance:250}]}}]});
  beforeEach(()=>{vi.stubEnv("ROUTING_PROVIDER","geoapify");vi.stubEnv("GEOAPIFY_API_KEY","geo-test-key");});

  it("uses drive consistently for the matrix and the verified route",async()=>{
    const fetcher=vi.fn().mockResolvedValueOnce(Response.json(matrix())).mockResolvedValueOnce(Response.json(route()));
    vi.stubGlobal("fetch",fetcher);
    await routeMatrix(points[0],[points[1]],["node/1"],"version",undefined,"drive");
    await routeDirections(points,120,"drive");
    expect(JSON.parse(fetcher.mock.calls[0][1].body).mode).toBe("drive");
    expect(new URL(fetcher.mock.calls[1][0]).searchParams.get("mode")).toBe("drive");
    expect(database.query).not.toHaveBeenCalled();
  });
  it("never reuses a walking matrix for driving",async()=>{
    vi.stubGlobal("fetch",vi.fn().mockImplementation(()=>Promise.resolve(Response.json(matrix()))));
    await routeMatrix(points[0],[points[1]],["node/1"],"version","node/start","walk");
    const walkKey=database.query.mock.calls[0][1][0];database.query.mockClear();
    await routeMatrix(points[0],[points[1]],["node/1"],"version","node/start","drive");
    expect(database.query.mock.calls[0][1][0]).not.toBe(walkKey);
  });

  it("sends one full walking matrix and preserves asymmetric costs without caching GPS",async()=>{
    const fetcher=vi.fn().mockResolvedValue(Response.json(matrix()));vi.stubGlobal("fetch",fetcher);
    expect(await routeMatrix(points[0],[points[1]],["node/1"],"version")).toEqual({durations:[[0,300],[500,0]],distances:[[0,400],[650,0]]});
    expect(fetcher).toHaveBeenCalledOnce();expect(database.query).not.toHaveBeenCalled();
    const [url,options]=fetcher.mock.calls[0];
    expect(new URL(url).pathname).toBe("/v1/routematrix");
    expect(new URL(url).searchParams.get("apiKey")).toBe("geo-test-key");
    expect(options.cache).toBe("no-store");
    expect(JSON.parse(options.body)).toEqual({mode:"walk",units:"metric",sources:[{location:[71.43,51.12]},{location:[71.44,51.13]}],targets:[{location:[71.43,51.12]},{location:[71.44,51.13]}]});
  });
  it("preserves null cells and null metrics for unreachable paths",async()=>{
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(Response.json({sources_to_targets:[
      [{source_index:0,target_index:0,time:0,distance:0},null],
      [{source_index:1,target_index:0,time:null,distance:null},{source_index:1,target_index:1,time:0,distance:0}]
    ]})));
    expect((await routeMatrix(points[0],[points[1]],["node/1"],"version")).durations).toEqual([[0,null],[null,0]]);
  });
  it("rejects incomplete matrices and incorrect cell indices",async()=>{
    for(const payload of [{sources_to_targets:[[null]]},{sources_to_targets:[[null,null]]},
      {sources_to_targets:matrix().sources_to_targets.map(row=>row.toReversed())}]){
      vi.stubGlobal("fetch",vi.fn().mockResolvedValue(Response.json(payload)));
      await expect(routeMatrix(points[0],[points[1]],["node/1"],"version")).rejects.toThrow("матриц");
    }
  });
  it("converts all route legs to planner segments in seconds and meters",async()=>{
    const fetcher=vi.fn().mockResolvedValue(Response.json(route()));vi.stubGlobal("fetch",fetcher);
    const result=await routeDirections(points);
    expect(result).toEqual({geometry:route().features[0].geometry,segments:[{duration:300,distance:400},{duration:200,distance:250}]});
    const url=new URL(fetcher.mock.calls[0][0]);
    expect(url.searchParams.get("waypoints")).toBe("51.12,71.43|51.13,71.44|51.14,71.45");
    expect(url.searchParams.get("mode")).toBe("walk");
    expect(url.searchParams.get("intermediate_waypoint_mode")).toBe("stopover");
    expect(url.searchParams.get("optimize_stops")).toBe("false");
  });
  it("checks both endpoints of every leg, including intermediate stops",async()=>{
    for(const [lineIndex,endpoint] of [[0,0],[0,1],[1,0],[1,1]]){
      const payload=route();payload.features[0].geometry.coordinates[lineIndex][endpoint]=[71.8,51.4];
      vi.stubGlobal("fetch",vi.fn().mockResolvedValue(Response.json(payload)));
      await expect(routeDirections(points)).rejects.toThrow("подход");
    }
  });
  it("rejects missing legs, invalid coordinates and missing geometry",async()=>{
    const missingLeg=route();missingLeg.features[0].properties.legs.pop();
    const invalidCoordinate=route();invalidCoordinate.features[0].geometry.coordinates[0][0]=[71.43];
    for(const payload of [missingLeg,invalidCoordinate,{features:[]}]){
      vi.stubGlobal("fetch",vi.fn().mockResolvedValue(Response.json(payload)));
      await expect(routeDirections(points)).rejects.toThrow();
    }
  });
  it("reports authentication, quota, network and invalid JSON failures without exposing the key or falling back",async()=>{
    for(const [status,message] of [[401,"GEOAPIFY_API_KEY"],[403,"GEOAPIFY_API_KEY"],[429,"Лимит"],[500,"недоступен"]] as const){
      const fetcher=vi.fn().mockResolvedValue(new Response("private error geo-test-key",{status}));vi.stubGlobal("fetch",fetcher);
      await expect(routeDirections(points)).rejects.toThrow(message);expect(fetcher).toHaveBeenCalledOnce();
    }
    vi.stubGlobal("fetch",vi.fn().mockRejectedValue(new DOMException("private URL geo-test-key","TimeoutError")));
    await expect(routeDirections(points)).rejects.toThrow("Geoapify не ответил за 12 секунд");
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response("invalid JSON geo-test-key")));
    await expect(routeDirections(points)).rejects.toThrow("Geoapify вернул некорректный ответ");
  });
  it("requires the selected key and rejects unknown providers before making requests",async()=>{
    const fetcher=vi.fn();vi.stubGlobal("fetch",fetcher);vi.stubEnv("GEOAPIFY_API_KEY","");
    await expect(routeDirections(points)).rejects.toThrow("GEOAPIFY_API_KEY");
    vi.stubEnv("ROUTING_PROVIDER","typo");
    await expect(routeDirections(points)).rejects.toThrow("ROUTING_PROVIDER");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("uses separate public-POI cache keys for each provider",async()=>{
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(Response.json(matrix())));
    await routeMatrix(points[0],[points[1]],["node/1"],"version","node/start");
    const geoKey=database.query.mock.calls[0][1][0];
    vi.stubEnv("ROUTING_PROVIDER","ors");database.query.mockClear();
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(Response.json({durations:[[0,300],[500,0]],distances:[[0,400],[650,0]]})));
    await routeMatrix(points[0],[points[1]],["node/1"],"version","node/start");
    expect(database.query.mock.calls[0][1][0]).not.toBe(geoKey);
  });
});

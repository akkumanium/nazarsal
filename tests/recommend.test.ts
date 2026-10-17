import { beforeEach,describe,expect,it,vi } from "vitest";
import { candidate,intent,matrix } from "./fixtures";
const services=vi.hoisted(()=>({
  active:vi.fn(),search:vi.fn(),parse:vi.fn(),find:vi.fn(),matrix:vi.fn(),directions:vi.fn(),select:vi.fn(),write:vi.fn()
}));
vi.mock("@/server/repository",()=>({activeVersion:services.active,searchPlaces:services.search}));
vi.mock("@/server/openai",()=>({parseIntent:services.parse,selectRecommendations:services.select,writeRecommendation:services.write}));
vi.mock("@/server/candidate-search",async()=>{
  const actual=await vi.importActual<typeof import("../src/server/candidate-search")>("../src/server/candidate-search");
  return {...actual,findCandidates:services.find};
});
vi.mock("@/server/routing",()=>({walkingMatrix:services.matrix,walkingDirections:services.directions}));
import { recommend } from "../src/server/recommend";
beforeEach(()=>{
  vi.resetAllMocks();
  services.active.mockResolvedValue("00000000-0000-4000-8000-000000000001");
  services.parse.mockResolvedValue(intent());services.find.mockResolvedValue([candidate("1")]);
  services.matrix.mockResolvedValue(matrix(2));
  services.directions.mockResolvedValue({geometry:{type:"LineString",coordinates:[[71.4304,51.1282],[71.431,51.129]]},segments:[{duration:300,distance:400}]});
  services.write.mockImplementation(async plans=>({plans,summary:"Тестовая рекомендация",source:"template"}));
  services.select.mockImplementation(async plans=>({plans,count:1,evaluations:[],source:"model"}));
});
describe("recommendation orchestration",()=>{
  it.each([1,2,3])("lets AI choose %i alternatives from all 12, including the last script candidate",async count=>{
    const candidates=Array.from({length:12},(_,i)=>candidate(String(i+1)));
    services.parse.mockResolvedValue(intent({mode:"alternatives"}));services.find.mockResolvedValue(candidates);services.matrix.mockResolvedValue(matrix(13));
    services.select.mockImplementation(async plans=>({plans:[...plans].reverse(),count,evaluations:candidates.map(p=>({poiId:p.id,reason:"Подходит запросу"})),source:"model"}));
    const r=await recommend({query:"Интересный кофе рядом",origin:{lat:51.1282,lon:71.4304},excludedPoiIds:[]});
    expect(services.select.mock.calls[0][0]).toHaveLength(12);expect(services.select.mock.calls[0][1]).toHaveLength(12);
    expect(r.plans).toHaveLength(count);expect(r.plans[0].stops[0].poi.id).toBe("node/12");expect(services.directions).toHaveBeenCalledTimes(count);
    expect(services.write.mock.calls[0][0]).toHaveLength(count);expect(r.selectionSource).toBe("model");
    expect(r.diagnostics.candidatePools![0].candidates).toHaveLength(12);expect(r.diagnostics.candidatePools![0].evaluations).toHaveLength(12);
  });
  it("tries AI-ranked backups when selected routes fail or violate the time budget",async()=>{
    services.parse.mockResolvedValue(intent({mode:"alternatives"}));services.find.mockResolvedValue(Array.from({length:6},(_,i)=>candidate(String(i+1))));services.matrix.mockResolvedValue(matrix(7));
    services.select.mockImplementation(async plans=>({plans:[...plans].reverse(),count:3,evaluations:[],source:"model"}));
    services.directions.mockRejectedValueOnce(new Error("No path")).mockResolvedValueOnce({geometry:{type:"LineString",coordinates:[]},segments:[{duration:7200,distance:400}]}).mockRejectedValueOnce(new Error("No path"));
    const r=await recommend({query:"Кофе",origin:{lat:51.1282,lon:71.4304},excludedPoiIds:[]});
    expect(r.plans.map(p=>p.id)).toEqual(["node/3","node/2","node/1"]);expect(services.directions).toHaveBeenCalledTimes(6);
    expect(r.diagnostics.candidatePools![0].routeChecks.map(c=>c.status)).toEqual(["error","infeasible","error","verified","verified","verified"]);
  });
  it("reports fallback selection explicitly",async()=>{
    services.select.mockImplementation(async plans=>({plans,count:1,evaluations:[],source:"fallback"}));
    const r=await recommend({query:"Кофе",origin:{lat:51.1282,lon:71.4304},excludedPoiIds:[]});
    expect(r.status).toBe("partial");expect(r.selectionSource).toBe("fallback");expect(r.unmetConditions.join(" ")).toContain("резервным алгоритмом");
  });
  it("omits candidate diagnostics in production",async()=>{
    vi.stubEnv("NODE_ENV","production");
    try{const r=await recommend({query:"Кофе",origin:{lat:51.1282,lon:71.4304},excludedPoiIds:[]});expect(r.diagnostics.candidatePools).toBeUndefined();}
    finally{vi.unstubAllEnvs();}
  });
  it("returns only database POIs with a verified route",async()=>{
    const r=await recommend({query:"Кофе рядом",origin:{lat:51.1282,lon:71.4304},excludedPoiIds:[]});
    expect(r.status).toBe("ok");expect(r.plans[0].verified).toBe(true);expect(r.plans[0].stops[0].poi.id).toBe("node/1");
    expect(services.matrix).toHaveBeenCalledTimes(1);expect(services.directions).toHaveBeenCalledTimes(1);expect(services.write).toHaveBeenCalledTimes(1);
  });
  it("asks for a start and never invents coordinates",async()=>{
    const r=await recommend({query:"Кофе рядом",excludedPoiIds:[]});expect(r.status).toBe("needs_clarification");expect(r.origin).toBeNull();expect(services.matrix).not.toHaveBeenCalled();
  });
  it("asks to resolve equally matching origins",async()=>{
    services.parse.mockResolvedValue(intent({originQuery:"Кафе"}));services.search.mockResolvedValue([{...candidate("1"),matchScore:2},{...candidate("2"),matchScore:2.1}]);
    const r=await recommend({query:"Я возле кафе",excludedPoiIds:[]});expect(r.status).toBe("needs_clarification");expect(r.originChoices).toHaveLength(2);
  });
  it("does not fabricate times or geometry when routing fails",async()=>{
    services.matrix.mockRejectedValue(new Error("Network unavailable"));
    const r=await recommend({query:"Кофе рядом",origin:{lat:51.1282,lon:71.4304},excludedPoiIds:[]});
    expect(r.status).toBe("service_unavailable");expect(r.plans).toHaveLength(0);expect(r.places[0].id).toBe("node/1");expect(services.write).not.toHaveBeenCalled();
  });
  it("does not relax mandatory conditions after an empty search",async()=>{
    services.parse.mockResolvedValue(intent({constraints:[{feature:"power_outlets",operator:"eq",value:true,strength:"must"}]}));services.find.mockResolvedValue([]);
    const r=await recommend({query:"Нужна розетка",origin:{lat:51.1282,lon:71.4304},excludedPoiIds:[]});
    expect(r.status).toBe("no_matches");expect(r.intent!.constraints[0].strength).toBe("must");expect(services.matrix).not.toHaveBeenCalled();
  });
  it("stops before the LLM when no dataset is published",async()=>{
    services.active.mockResolvedValue(null);const r=await recommend({query:"Погулять",excludedPoiIds:[]});expect(r.status).toBe("service_unavailable");expect(services.parse).not.toHaveBeenCalled();
  });
});

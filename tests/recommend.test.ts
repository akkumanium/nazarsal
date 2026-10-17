import { beforeEach,describe,expect,it,vi } from "vitest";
import { candidate,intent,matrix } from "./fixtures";
const services=vi.hoisted(()=>({
  active:vi.fn(),search:vi.fn(),parse:vi.fn(),find:vi.fn(),matrix:vi.fn(),directions:vi.fn(),write:vi.fn()
}));
vi.mock("@/server/repository",()=>({activeVersion:services.active,searchPlaces:services.search}));
vi.mock("@/server/openai",()=>({parseIntent:services.parse,writeRecommendation:services.write}));
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
});
describe("recommendation orchestration",()=>{
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

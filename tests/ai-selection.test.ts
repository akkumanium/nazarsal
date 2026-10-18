import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
import { candidate,intent,matrix } from "./fixtures";
import { enumeratePlans,selectPlanOptions } from "../src/server/route-planner";

const api=vi.hoisted(()=>({parse:vi.fn()}));
vi.mock("openai",()=>({default:class {
  static APIError=class extends Error {};
  responses={parse:api.parse};
}}));
import { selectRecommendations } from "../src/server/openai";

const candidates=Array.from({length:12},(_,i)=>candidate(String(i+1)));
const searchIntent=intent({mode:"alternatives"});
const plans=enumeratePlans(candidates,matrix(13),searchIntent,new Date("2026-10-17T08:00:00Z"));
const valid=()=>({count:2,rankedPlanIds:[...plans].reverse().map(p=>p.id),evaluations:candidates.map(p=>({poiId:p.id,reason:"Соответствует запросу"}))});
beforeEach(()=>{vi.resetAllMocks();vi.stubEnv("OPENAI_API_KEY","test-key");});
afterEach(()=>vi.unstubAllEnvs());

describe("AI candidate selection",()=>{
  it.each(["kk", "ru", "en"] as const)("passes the selected %s language to the model", async language => {
    api.parse.mockResolvedValue({status:"completed",output_parsed:valid()});
    await selectRecommendations(plans,candidates,searchIntent,"Кофе",language);
    const input=api.parse.mock.calls[0][0].input;
    expect(JSON.parse(input[1].content).responseLanguage).toBe(language);
    expect(input[0].content).toContain("этот явный выбор имеет приоритет над языком запроса");
  });
  it.each([1,2,3])("accepts AI's choice of %i and ranking across all 12 candidates",async count=>{
    api.parse.mockResolvedValue({status:"completed",output_parsed:{...valid(),count}});
    const result=await selectRecommendations(plans,candidates,searchIntent,"Необычное кафе");
    expect(result.source).toBe("model");expect(result.count).toBe(count);expect(result.plans[0].id).toBe(plans.at(-1)!.id);
    const payload=JSON.parse(api.parse.mock.calls[0][0].input[1].content);
    expect(payload.candidates).toHaveLength(12);expect(payload.plans).toHaveLength(12);
    expect(payload.candidates[11]).toMatchObject({poiId:"node/12",tags:candidates[11].tags,facts:candidates[11].features});
    expect(payload.candidates[0].point).toBeUndefined();
  });
  it.each(["invented plan","duplicate plan","missing plan","missing evaluation","invented candidate","duplicate candidate","too many choices","zero choices"])("rejects %s and uses explicit fallback",async problem=>{
    const response=valid();
    if(problem==="invented plan")response.rankedPlanIds[0]="node/invented";
    if(problem==="duplicate plan")response.rankedPlanIds[0]=response.rankedPlanIds[1];
    if(problem==="missing plan")response.rankedPlanIds.pop();
    if(problem==="missing evaluation")response.evaluations.pop();
    if(problem==="invented candidate")response.evaluations[0].poiId="node/invented";
    if(problem==="duplicate candidate")response.evaluations[0].poiId=response.evaluations[1].poiId;
    if(problem==="too many choices")response.count=4;
    if(problem==="zero choices")response.count=0;
    api.parse.mockResolvedValue({status:"completed",output_parsed:response});
    const result=await selectRecommendations(plans,candidates,searchIntent,"Кофе");
    expect(result.source).toBe("fallback");expect(result.plans).toEqual(plans);expect(result.count).toBe(3);expect(result.evaluations).toEqual([]);
  });
  it("falls back when the API is unavailable",async()=>{
    api.parse.mockRejectedValue(new Error("Unavailable"));
    expect((await selectRecommendations(plans,candidates,searchIntent,"Кофе")).source).toBe("fallback");
  });
  it("keeps itineraries to one feasible plan",async()=>{
    const i=intent();const options=selectPlanOptions(enumeratePlans(candidates,matrix(13),i,new Date("2026-10-17T08:00:00Z")),candidates);
    expect(options).toHaveLength(12);
    expect(new Set(options.flatMap(p=>p.stops.map(s=>s.poi.id))).size).toBe(12);
    api.parse.mockResolvedValue({status:"completed",output_parsed:{...valid(),count:2,rankedPlanIds:options.map(p=>p.id)}});
    expect((await selectRecommendations(options,candidates,i,"Прогулка")).source).toBe("fallback");
    api.parse.mockResolvedValue({status:"completed",output_parsed:{...valid(),count:1,rankedPlanIds:[...options].reverse().map(p=>p.id)}});
    const result=await selectRecommendations(options,candidates,i,"Прогулка");
    expect(result.source).toBe("model");expect(result.count).toBe(1);expect(result.plans[0]).toEqual(options.at(-1));
  });
});

import { beforeEach,describe,expect,it,vi } from "vitest";
const service=vi.hoisted(()=>({recommend:vi.fn()}));
vi.mock("@/server/recommend",()=>({recommend:service.recommend}));
import { POST } from "../src/app/api/recommend/route";
beforeEach(()=>{vi.stubEnv("OPENAI_API_KEY","");service.recommend.mockReset();});
function request(body:unknown,headers:Record<string,string>={}){return new Request("http://localhost:3000/api/recommend",{method:"POST",headers:{"Content-Type":"application/json",...headers},body:JSON.stringify(body)});}
describe("public API validation",()=>{
  it("rejects cross-origin use before any service calls",async()=>{const r=await POST(request({query:"Парк"},{origin:"https://other.example"}));expect(r.status).toBe(403);expect(service.recommend).not.toHaveBeenCalled();});
  it("rejects invalid coordinates and unrecognised controls",async()=>{for(const body of [{query:"Парк",origin:{lat:200,lon:71}},{query:"Парк",controls:{sql:"DROP TABLE poi"}}]){expect((await POST(request(body))).status).toBe(400);}expect(service.recommend).not.toHaveBeenCalled();});
  it("returns unavailable without fake recommendations",async()=>{service.recommend.mockResolvedValue({status:"service_unavailable",plans:[],places:[],message:"Нет данных"});const r=await POST(request({query:"Парк"}));expect(r.status).toBe(503);expect((await r.json()).plans).toEqual([]);});
});

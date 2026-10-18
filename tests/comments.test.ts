import { describe, expect, it, vi } from "vitest";
import { commentInputSchema, mapBoundsSchema, profileNameSchema } from "../src/lib/comments";
const database=vi.hoisted(()=>({query:vi.fn()}));
vi.mock("@/server/db",()=>({query:database.query,transaction:vi.fn()}));
import { GET, POST } from "../src/app/api/comments/route";
import { PATCH as updateProfile } from "../src/app/api/community/profile/route";

describe("comment request validation",()=>{
  it("validates profile names without accepting another user's identity",async()=>{
    expect(profileNameSchema.parse({name:"  Аружан  "})).toEqual({name:"Аружан"});
    for(const body of [{name:" "},{name:"A"},{name:"a".repeat(61)},{name:"Name\nInjected"},{name:"Valid",id:"someone-else"}])expect(profileNameSchema.safeParse(body).success).toBe(false);
    database.query.mockClear();
    const denied=await updateProfile(new Request("http://localhost/api/community/profile",{method:"PATCH",headers:{origin:"https://other.example"},body:JSON.stringify({name:"Other"})}));
    expect(denied.status).toBe(403);expect(database.query).not.toHaveBeenCalled();
    const anonymous=await updateProfile(new Request("http://localhost/api/community/profile",{method:"PATCH",body:JSON.stringify({name:"Other"})}));
    expect(anonymous.status).toBe(401);
  });
  const input={poiId:"node/123",text:"Helpful tip",lifetimeHours:24,visibility:"public"};
  it("requires an allowed duration and an explicit audience",()=>{
    expect(commentInputSchema.safeParse(input).success).toBe(true);
    for(const patch of [{lifetimeHours:0},{lifetimeHours:999},{lifetimeHours:undefined},{visibility:"everyone"},{visibility:undefined},{text:" "},{poiId:"custom-pin"},{lat:51.1},{authorId:"someone-else"},{expiresAt:"2099-01-01"}]){
      expect(commentInputSchema.safeParse({...input,...patch}).success).toBe(false);
    }
  });
  it("rejects unbounded, reversed, or absent map windows",()=>{
    expect(mapBoundsSchema.safeParse({west:71.3,south:51.1,east:71.5,north:51.3}).success).toBe(true);
    expect(mapBoundsSchema.safeParse({west:-180,south:-90,east:180,north:90}).success).toBe(false);
    expect(mapBoundsSchema.safeParse({west:72,south:51,east:71,north:52}).success).toBe(false);
    expect(mapBoundsSchema.safeParse({}).success).toBe(false);
  });
  it("rejects cross-origin publication and invalid map requests before database work",async()=>{
    database.query.mockClear();
    const result=await POST(new Request("http://localhost/api/comments",{method:"POST",headers:{origin:"https://other.example"},body:JSON.stringify(input)}));
    expect(result.status).toBe(403);
    expect((await GET(new Request("http://localhost/api/comments"))).status).toBe(400);
    expect(database.query).not.toHaveBeenCalled();
  });
  it("rejects publication without a server-side session",async()=>{
    const result=await POST(new Request("http://localhost/api/comments",{method:"POST",body:JSON.stringify(input)}));
    expect(result.status).toBe(401);
  });
});

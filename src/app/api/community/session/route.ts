import { COMMUNITY_COOKIE, communityError, createCommunitySession, currentProfile, requireCommunityOrigin, sessionBudget } from "@/server/comments";
import { json } from "@/server/http";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    requireCommunityOrigin(request);
    const existing = await currentProfile(request);
    if (existing) return json({ profile: existing });
    await sessionBudget(request);
    const { profile, token, maxAge } = await createCommunitySession();
    const response = json({ profile });
    response.cookies.set(COMMUNITY_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: new URL(request.url).protocol === "https:", path: "/", maxAge });
    return response;
  } catch (error) { return communityError(error); }
}

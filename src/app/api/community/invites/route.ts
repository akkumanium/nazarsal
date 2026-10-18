import { communityBudget, communityError, createFriendInvite, requireCommunityOrigin, requireProfile } from "@/server/comments";
import { json } from "@/server/http";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    requireCommunityOrigin(request); const profile = await requireProfile(request);
    await communityBudget(`invite:${profile.id}`, 10);
    return json({ code: await createFriendInvite(profile) });
  } catch (error) { return communityError(error); }
}

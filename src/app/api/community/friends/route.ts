import { z } from "zod";
import { acceptFriendInvite, communityBudget, communityError, communityFriends, readCommunityBody, removeCommunityFriend, requireCommunityOrigin, requireProfile } from "@/server/comments";
import { json } from "@/server/http";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try { return json({ friends: await communityFriends(await requireProfile(request)) }); }
  catch (error) { return communityError(error); }
}
export async function POST(request: Request) {
  try {
    requireCommunityOrigin(request); const profile = await requireProfile(request);
    await communityBudget(`friend:${profile.id}`, 20);
    const parsed = z.object({ code: z.string().trim().regex(/^[A-Za-z0-9_-]{32}$/) }).strict().safeParse(await readCommunityBody(request));
    if (!parsed.success) return json({ error: "Проверьте код приглашения." }, 400);
    await acceptFriendInvite(profile, parsed.data.code);
    return json({ friends: await communityFriends(profile) });
  } catch (error) { return communityError(error); }
}
export async function DELETE(request: Request) {
  try {
    requireCommunityOrigin(request); const profile = await requireProfile(request);
    const parsed = z.object({ friendId: z.string().uuid() }).strict().safeParse(await readCommunityBody(request));
    if (!parsed.success) return json({ error: "Проверьте пользователя." }, 400);
    await removeCommunityFriend(profile, parsed.data.friendId);
    return json({ friends: await communityFriends(profile) });
  } catch (error) { return communityError(error); }
}

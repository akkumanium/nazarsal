import { profileNameSchema } from "@/lib/comments";
import { communityBudget, communityError, communityProfileSummary, readCommunityBody, requireCommunityOrigin, requireProfile, updateCommunityProfileName } from "@/server/comments";
import { json } from "@/server/http";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try { return json(await communityProfileSummary(await requireProfile(request))); }
  catch (error) { return communityError(error); }
}
export async function PATCH(request: Request) {
  try {
    requireCommunityOrigin(request); const profile = await requireProfile(request);
    const parsed = profileNameSchema.safeParse(await readCommunityBody(request));
    if (!parsed.success) return json({ error: "Имя должно содержать от 2 до 60 символов." }, 400);
    await communityBudget(`profile:${profile.id}`, 20);
    return json({ profile: await updateCommunityProfileName(profile, parsed.data.name) });
  } catch (error) { return communityError(error); }
}

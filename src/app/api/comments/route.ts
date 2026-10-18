import { z } from "zod";
import { commentInputSchema, mapBoundsSchema } from "@/lib/comments";
import { communityBudget, communityError, currentProfile, deleteMapComment, listMapComments, publishMapComment, readCommunityBody, requireCommunityOrigin, requireProfile } from "@/server/comments";
import { json } from "@/server/http";
export const runtime = "nodejs";
export async function GET(request: Request) {
  const parsed = mapBoundsSchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return json({ error: "Приблизьте карту, чтобы увидеть комментарии." }, 400);
  try { return json({ comments: await listMapComments(parsed.data, await currentProfile(request)) }); }
  catch (error) { return communityError(error); }
}
export async function POST(request: Request) {
  try {
    requireCommunityOrigin(request); const profile = await requireProfile(request);
    await communityBudget(`publish:${profile.id}`, 12);
    const parsed = commentInputSchema.safeParse(await readCommunityBody(request));
    if (!parsed.success) return json({ error: "Укажите место, текст, срок показа и видимость." }, 400);
    const id = await publishMapComment(profile, parsed.data);
    return json({ id }, 201);
  } catch (error) { return communityError(error); }
}
export async function DELETE(request: Request) {
  try {
    requireCommunityOrigin(request); const profile = await requireProfile(request);
    const parsed = z.object({ id: z.string().uuid() }).strict().safeParse(await readCommunityBody(request));
    if (!parsed.success) return json({ error: "Проверьте комментарий." }, 400);
    await deleteMapComment(profile, parsed.data.id);
    return json({ deleted: true });
  } catch (error) { return communityError(error); }
}

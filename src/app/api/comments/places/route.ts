import { mapBoundsSchema } from "@/lib/comments";
import { commentPlaces, communityError } from "@/server/comments";
import { json } from "@/server/http";
export const runtime = "nodejs";
export async function GET(request: Request) {
  const parsed = mapBoundsSchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return json({ error: "Приблизьте карту, чтобы выбрать место." }, 400);
  try { return json(await commentPlaces(parsed.data)); }
  catch (error) { return communityError(error); }
}

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { query, transaction } from "./db";
import { json, sameOrigin } from "./http";
import type { CommentInput, CommentPlace, CommunityProfile, MapBounds, MapComment, ProfileSummary } from "@/lib/comments";

export const COMMUNITY_COOKIE = "nazarsal_community";
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const iso = (value: Date | string) => new Date(value).toISOString();
export class CommunityError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export function communityError(error: unknown) {
  return error instanceof CommunityError ? json({ error: error.message }, error.status)
    : json({ error: "Комментарии пока недоступны. Проверьте подключение и миграции базы." }, 503);
}
export function requireCommunityOrigin(request: Request) {
  if (!sameOrigin(request)) throw new CommunityError("Недопустимый источник запроса.", 403);
}
export async function readCommunityBody(request: Request): Promise<unknown> {
  if (Number(request.headers.get("content-length")) > 8000) throw new CommunityError("Слишком большой запрос.", 413);
  const body = await request.text();
  if (body.length > 8000) throw new CommunityError("Слишком большой запрос.", 413);
  try { return JSON.parse(body); } catch { throw new CommunityError("Ожидается JSON."); }
}
export async function currentProfile(request: Request): Promise<CommunityProfile | null> {
  const token = request.headers.get("cookie")?.split(";").map(part => part.trim()).find(part => part.startsWith(`${COMMUNITY_COOKIE}=`))?.slice(COMMUNITY_COOKIE.length + 1);
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const rows = await query<CommunityProfile>(`SELECT p.id,p.name FROM community_sessions s
    JOIN community_profiles p ON p.id=s.profile_id WHERE s.token_hash=$1 AND s.expires_at>now()`, [hash(token)]);
  return rows[0] ?? null;
}
export async function requireProfile(request: Request) {
  const profile = await currentProfile(request);
  if (!profile) throw new CommunityError("Откройте комментарии ещё раз, чтобы восстановить профиль.", 401);
  return profile;
}
export async function createCommunitySession() {
  const token = randomBytes(32).toString("base64url"), id = randomUUID();
  const profile = { id, name: `Nazar ${id.slice(0, 4).toUpperCase()}` };
  await transaction(async client => {
    await client.query("INSERT INTO community_profiles(id,name) VALUES($1,$2)", [id, profile.name]);
    await client.query("INSERT INTO community_sessions(token_hash,profile_id,expires_at) VALUES($1,$2,now()+interval '30 days')", [hash(token), id]);
  });
  return { token, profile, maxAge: SESSION_SECONDS };
}
export async function communityBudget(bucket: string, limit: number, windowSeconds = 3600) {
  const window = Math.floor(Date.now() / (windowSeconds * 1000));
  const rows = await query(`INSERT INTO request_budgets(bucket,count,expires_at) VALUES($1,1,now()+interval '2 days')
    ON CONFLICT(bucket) DO UPDATE SET count=request_budgets.count+1 WHERE request_budgets.count<$2 RETURNING count`, [`community:${bucket}:${window}`, limit]);
  if (!rows.length) throw new CommunityError("Слишком много действий. Попробуйте позже.", 429);
}
export async function sessionBudget(request: Request) {
  // Only a digest is persisted. The proxy must normalize forwarded IP headers in production.
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  await communityBudget(`session:${hash(ip)}`, 30);
}

const boundsValues = (b: MapBounds) => [b.west, b.south, b.east, b.north];
const visiblePoint = "ST_Covers(ST_MakeEnvelope($1,$2,$3,$4,4326),p.display_point)";
export async function commentPlaces(bounds: MapBounds): Promise<{ places: CommentPlace[]; truncated: boolean }> {
  const rows = await query<{ id: string; name: string; lat: number; lon: number }>(`SELECT p.id,p.name,
    ST_Y(p.display_point) lat,ST_X(p.display_point) lon FROM active_poi p
    WHERE p.display_point IS NOT NULL AND ${visiblePoint}
    ORDER BY p.named DESC, ST_Distance(p.display_point,ST_Centroid(ST_MakeEnvelope($1,$2,$3,$4,4326))),p.id LIMIT 121`, boundsValues(bounds));
  return { places: rows.slice(0, 120).map(p => ({ id: p.id, name: p.name, point: { lat: p.lat, lon: p.lon } })), truncated: rows.length > 120 };
}
type CommentRow = {
  id: string; poi_id: string; name: string; lat: number; lon: number; body: string;
  visibility: "public" | "friends"; author_id: string; author_name: string;
  created_at: Date | string; expires_at: Date | string; can_delete: boolean;
};
export async function listMapComments(bounds: MapBounds, viewer: CommunityProfile | null): Promise<MapComment[]> {
  const rows = await query<CommentRow>(`SELECT c.id,c.poi_id,p.name,ST_Y(p.display_point) lat,ST_X(p.display_point) lon,
    c.body,c.visibility,c.author_id,a.name author_name,c.created_at,c.expires_at,(c.author_id=$5::uuid) can_delete
    FROM map_comments c JOIN active_poi p ON p.id=c.poi_id JOIN community_profiles a ON a.id=c.author_id
    WHERE c.expires_at>now() AND p.display_point IS NOT NULL AND ${visiblePoint}
    AND (c.visibility='public' OR c.author_id=$5::uuid OR EXISTS (
      SELECT 1 FROM community_friendships f WHERE f.profile_low=LEAST(c.author_id,$5::uuid)
      AND f.profile_high=GREATEST(c.author_id,$5::uuid) AND $5::uuid IS NOT NULL
    )) ORDER BY c.created_at DESC,c.id LIMIT 300`, [...boundsValues(bounds), viewer?.id ?? null]);
  return rows.map(r => ({ id: r.id, place: { id: r.poi_id, name: r.name, point: { lat: r.lat, lon: r.lon } },
    text: r.body, visibility: r.visibility, author: { id: r.author_id, name: r.author_name },
    createdAt: iso(r.created_at), expiresAt: iso(r.expires_at), canDelete: !!r.can_delete }));
}
export async function publishMapComment(profile: CommunityProfile, input: CommentInput) {
  const id = randomUUID();
  const rows = await query(`INSERT INTO map_comments(id,author_id,poi_id,body,visibility,created_at,expires_at)
    SELECT $1,$2,p.id,$4,$5,now(),now()+($6::int*interval '1 hour') FROM active_poi p
    WHERE p.id=$3 AND p.display_point IS NOT NULL RETURNING id`, [id, profile.id, input.poiId, input.text, input.visibility, input.lifetimeHours]);
  if (!rows.length) throw new CommunityError("Выберите существующее место на карте.", 404);
  return id;
}
export async function deleteMapComment(profile: CommunityProfile, id: string) {
  const rows = await query("DELETE FROM map_comments WHERE id=$1 AND author_id=$2 RETURNING id", [id, profile.id]);
  if (!rows.length) throw new CommunityError("Комментарий не найден или принадлежит другому пользователю.", 404);
}
export async function communityFriends(profile: CommunityProfile): Promise<CommunityProfile[]> {
  return query<CommunityProfile>(`SELECT p.id,p.name FROM community_friendships f JOIN community_profiles p
    ON p.id=CASE WHEN f.profile_low=$1 THEN f.profile_high ELSE f.profile_low END
    WHERE f.profile_low=$1 OR f.profile_high=$1 ORDER BY p.name,p.id`, [profile.id]);
}
export async function createFriendInvite(profile: CommunityProfile) {
  const code = randomBytes(24).toString("base64url");
  await query(`INSERT INTO community_invites(profile_id,token_hash,expires_at) VALUES($1,$2,now()+interval '24 hours')
    ON CONFLICT(profile_id) DO UPDATE SET token_hash=EXCLUDED.token_hash,expires_at=EXCLUDED.expires_at`, [profile.id, hash(code)]);
  return code;
}
export async function acceptFriendInvite(profile: CommunityProfile, code: string) {
  await transaction(async client => {
    const { rows } = await client.query(`DELETE FROM community_invites WHERE token_hash=$1 AND expires_at>now()
      AND profile_id<>$2 RETURNING profile_id`, [hash(code), profile.id]);
    if (!rows.length) throw new CommunityError("Код приглашения недействителен или уже использован.");
    await client.query(`INSERT INTO community_friendships(profile_low,profile_high)
      VALUES(LEAST($1::uuid,$2::uuid),GREATEST($1::uuid,$2::uuid)) ON CONFLICT DO NOTHING`, [profile.id, rows[0].profile_id]);
  });
}
export async function removeCommunityFriend(profile: CommunityProfile, friendId: string) {
  await query("DELETE FROM community_friendships WHERE profile_low=LEAST($1::uuid,$2::uuid) AND profile_high=GREATEST($1::uuid,$2::uuid)", [profile.id, friendId]);
}
export async function communityProfileSummary(profile: CommunityProfile): Promise<ProfileSummary> {
  const [friends, comments] = await Promise.all([
    communityFriends(profile),
    query<{ count: number }>(`SELECT count(*)::int count FROM map_comments c JOIN active_poi p ON p.id=c.poi_id
      WHERE c.author_id=$1 AND c.expires_at>now()`, [profile.id]),
  ]);
  return { profile, friendsCount: friends.length, activeComments: comments[0]?.count ?? 0 };
}
export async function updateCommunityProfileName(profile: CommunityProfile, name: string): Promise<CommunityProfile> {
  const rows = await query<CommunityProfile>("UPDATE community_profiles SET name=$2 WHERE id=$1 RETURNING id,name", [profile.id, name]);
  if (!rows.length) throw new CommunityError("Профиль не найден.", 404);
  return rows[0];
}

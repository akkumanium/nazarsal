import type { SearchIntent } from "@/lib/intent";
import type { Candidate, FeatureEvidence, Poi, Point } from "@/lib/types";
import { query } from "./db";
import { POI_SELECT, toPoi, type PoiRow } from "./repository";
import { canOpenDuring } from "./opening-hours";

export function featureMatches(evidence: FeatureEvidence, operator: string, value: string | number | boolean): boolean | null {
  if (evidence.value === null || evidence.basis === "unknown") return null;
  if (operator === "eq") return evidence.value === value;
  if (typeof evidence.value !== "number" || typeof value !== "number") return null;
  return operator === "lte" ? evidence.value <= value : evidence.value >= value;
}
export function fitsMust(poi: Poi, intent: SearchIntent): boolean {
  return !poi.categories.some(c => intent.excludedCategoryIds.includes(c)) && intent.constraints
    .filter(c => c.strength === "must" && c.feature !== "open_now")
    .every(c => featureMatches(poi.features[c.feature], c.operator, c.value) === true);
}
export function selectDiverseCandidates(candidates: Candidate[], intent: SearchIntent, limit = 12): Candidate[] {
  const selected: Candidate[] = [];
  const add = (p: Candidate) => {
    if(selected.some(s=>s.id===p.id||((p.parentPoiId===s.id||s.parentPoiId===p.id)&&s.categories.some(c=>p.categories.includes(c)))))return;
    if(selected.length<limit)selected.push(p);
  };
  const goals = [...intent.goals].sort((a,b) => Number(b.required)-Number(a.required) || Number(b.priority === "primary")-Number(a.priority === "primary"));
  // Round-robin representation before filling with global best.
  for (let round = 0; round < 2; round++) for (const goal of goals) {
    const matches = candidates.filter(p => p.categories.some(c => goal.categoryIds.includes(c)));
    if (matches[round]) add(matches[round]);
  }
  for (const p of candidates) add(p);
  return selected;
}
export function searchRadii(intent: SearchIntent): number[] {
  const minutes = intent.durationMinutes ?? 60;
  const reserve = Math.max(5, minutes * .1);
  // Deliberately generous straight-line upper bound, not a walking-time estimate.
  const timeCap = Math.max(50, (minutes - reserve) * 100 / (intent.returnToStart ? 2 : 1));
  const cap = Math.min(intent.maxRadiusMeters ?? 5000, timeCap, 5000);
  return [...new Set([800,1500,3000,5000].map(r => Math.min(r,cap)))].sort((a,b)=>a-b);
}
export async function findCandidates(intent: SearchIntent, origin: Point, radius: number, version: string, excluded: string[], start: Date): Promise<Candidate[]> {
  const goals = intent.goals;
  const categories = [...new Set(goals.flatMap(g => g.categoryIds))];
  const must = intent.constraints.filter(c => c.strength === "must" && c.feature !== "open_now");
  const prefer = intent.constraints.filter(c => c.strength === "prefer" && c.feature !== "open_now");
  const rows = await query<PoiRow & { distance_m: number; score: number; category_fit: number; preference_fit: number }>(`
    WITH nearby AS (
      SELECT p.*,ST_Distance(p.geog,ST_SetSRID(ST_Point($1,$2),4326)::geography) distance_m
      FROM poi p WHERE p.run_id=$3::uuid AND (p.named OR p.tags->>'leisure'='playground')
      AND p.duplicate_of IS NULL AND p.public_access AND p.geog IS NOT NULL
      AND ST_DWithin(p.geog,ST_SetSRID(ST_Point($1,$2),4326)::geography,$4)
      AND (cardinality($5::text[])=0 OR p.category_ids && $5::text[])
      AND NOT (p.category_ids && $6::text[]) AND NOT(p.id=ANY($7::text[]))
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements($8::jsonb) c
        WHERE p.features->(c->>'feature')->>'basis'='unknown'
        OR p.features->(c->>'feature')->'value' IS NULL
        OR p.features->(c->>'feature')->'value'='null'::jsonb
        OR CASE c->>'operator'
          WHEN 'eq' THEN p.features->(c->>'feature')->'value' IS DISTINCT FROM c->'value'
          WHEN 'lte' THEN jsonb_typeof(p.features->(c->>'feature')->'value')<>'number' OR
            CASE WHEN jsonb_typeof(p.features->(c->>'feature')->'value')='number' THEN (p.features->(c->>'feature')->>'value')::numeric>(c->>'value')::numeric ELSE true END
          WHEN 'gte' THEN jsonb_typeof(p.features->(c->>'feature')->'value')<>'number' OR
            CASE WHEN jsonb_typeof(p.features->(c->>'feature')->'value')='number' THEN (p.features->(c->>'feature')->>'value')::numeric<(c->>'value')::numeric ELSE true END
          ELSE true END)
    ), fits AS (
      SELECT p.*,
        COALESCE((SELECT sum((CASE WHEN g->>'priority'='primary' THEN 1.0 ELSE .5 END)*
          CASE WHEN p.category_ids && ARRAY(SELECT jsonb_array_elements_text(g->'categoryIds')) THEN 1 ELSE 0 END)
          /NULLIF(sum(CASE WHEN g->>'priority'='primary' THEN 1.0 ELSE .5 END),0)
          FROM jsonb_array_elements($9::jsonb) g),1)::float category_fit,
        COALESCE((SELECT avg(CASE
          WHEN p.features->(c->>'feature')->'value' IS NULL OR p.features->(c->>'feature')->'value'='null'::jsonb THEN .5
          WHEN c->>'operator'='eq' THEN CASE WHEN p.features->(c->>'feature')->'value'=c->'value' THEN 1.0 ELSE 0 END
          WHEN jsonb_typeof(p.features->(c->>'feature')->'value')='number' AND jsonb_typeof(c->'value')='number'
            THEN CASE WHEN (c->>'operator'='lte' AND (p.features->(c->>'feature')->>'value')::numeric<=(c->>'value')::numeric)
              OR (c->>'operator'='gte' AND (p.features->(c->>'feature')->>'value')::numeric>=(c->>'value')::numeric) THEN 1.0 ELSE 0 END
          ELSE .5 END) FROM jsonb_array_elements($10::jsonb) c),.5)::float preference_fit
      FROM nearby p
    ), scored AS (
      SELECT *, .60*category_fit+.30*greatest(0,1-distance_m/$4)+.10*preference_fit score FROM fits
    ), chosen AS (
      (SELECT id FROM scored ORDER BY score DESC,id LIMIT 36)
      UNION
      SELECT id FROM jsonb_array_elements($9::jsonb) g CROSS JOIN LATERAL
        (SELECT id FROM scored p WHERE p.category_ids && ARRAY(SELECT jsonb_array_elements_text(g->'categoryIds'))
         ORDER BY score DESC,id LIMIT 3) per_goal
    ) SELECT ${POI_SELECT} FROM scored p JOIN chosen c ON c.id=p.id ORDER BY score DESC,p.id LIMIT 60`,
    [origin.lon,origin.lat,version,radius,categories,intent.excludedCategoryIds,excluded,JSON.stringify(must),JSON.stringify(goals),JSON.stringify(prefer)]);
  const end = new Date(start.getTime()+(intent.durationMinutes??60)*60000);
  return rows.map(r=>({...toPoi(r),distanceMeters:r.distance_m,score:r.score,categoryFit:r.category_fit,preferenceFit:r.preference_fit}))
    .filter(p=>canOpenDuring(p,start,end));
}

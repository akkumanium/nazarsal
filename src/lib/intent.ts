import { z } from "zod";
import { CATEGORY_IDS, FEATURE_IDS } from "./catalog";
import { TRAVEL_MODES, type TravelMode } from "./travel";

const constraintSchema = z.object({
  feature: z.enum(FEATURE_IDS), operator: z.enum(["eq", "lte", "gte"]),
  value: z.union([z.string(), z.number(), z.boolean()]), strength: z.enum(["must", "prefer"])
}).strict();
export const intentSchema = z.object({
  mode: z.enum(["alternatives", "itinerary"]), originQuery: z.string().max(200).nullable(),
  durationMinutes: z.number().int().min(10).max(480).nullable(),
  maxWalkingMinutes: z.number().min(0).max(480).nullable(),
  maxRadiusMeters: z.number().min(50).max(20000).nullable(), returnToStart: z.boolean(),
  goals: z.array(z.object({ categoryIds: z.array(z.enum(CATEGORY_IDS)).min(1).max(12), priority: z.enum(["primary", "secondary"]), required: z.boolean() }).strict()).max(8),
  excludedCategoryIds: z.array(z.enum(CATEGORY_IDS)).max(12),
  constraints: z.array(constraintSchema).max(16),
  unresolvedPreferences: z.array(z.string().max(200)).max(12), clarification: z.string().max(400).nullable()
}).strict();
export type SearchIntent = z.infer<typeof intentSchema> & { travelMode?: TravelMode };
export const pointSchema = z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180), label: z.string().max(200).optional() }).strict();
export const requestSchema = z.object({
  language: z.enum(["kk", "ru", "en"]).optional(),
  travelMode: z.enum(TRAVEL_MODES).optional(),
  query: z.string().trim().min(1).max(2000), origin: pointSchema.nullable().optional(),
  previousIntent: intentSchema.extend({ travelMode: z.enum(TRAVEL_MODES).optional() }).nullable().optional(), excludedPoiIds: z.array(z.string().max(80)).max(30).default([]),
  startAt: z.string().datetime({ offset: true }).optional(),
  controls: z.object({
    durationMinutes: z.number().int().min(10).max(480).optional(),
    maxWalkingMinutes: z.number().min(0).max(480).nullable().optional(), returnToStart: z.boolean().optional()
  }).strict().optional(),
  confirmedOriginQuery: z.string().max(200).optional()
}).strict();
export type RecommendRequest = z.infer<typeof requestSchema>;
export function withDefaults(intent: SearchIntent, controls?: RecommendRequest["controls"]): SearchIntent {
  const next = { ...intent, ...controls, durationMinutes: controls?.durationMinutes ?? intent.durationMinutes ?? 60 };
  next.constraints = next.constraints.filter((c, index, all) => all.findLastIndex(x => x.feature === c.feature && x.strength === c.strength) === index);
  for (const c of next.constraints) {
    if (c.operator !== "eq" && typeof c.value !== "number") throw new Error("Некорректное сравнение характеристики");
    if (typeof c.value === "number" && !Number.isFinite(c.value)) throw new Error("Некорректное значение характеристики");
  }
  next.goals = next.goals.map(g => ({ ...g, categoryIds: [...new Set(g.categoryIds)].filter(id => !next.excludedCategoryIds.includes(id)) }));
  if (next.goals.some(g => g.required && !g.categoryIds.length)) next.clarification = "В запросе одна категория одновременно обязательна и исключена. Какое условие сохранить?";
  next.goals = next.goals.filter(g => g.categoryIds.length > 0);
  if(next.mode==="itinerary"&&next.goals.filter(g=>g.required).length>3)next.clarification="В один маршрут можно включить до трёх последовательных остановок. Какие три цели оставить?";
  return next;
}

import type { FeatureCollection, Geometry, LineString, MultiLineString, MultiPolygon, Polygon } from "geojson";
import type { CategoryId, FeatureId } from "./catalog";
import type { SearchIntent } from "./intent";

export type Point = { lat: number; lon: number; label?: string };
export type FeatureEvidence = { value: boolean | string | number | null; tag: string | null; basis: "explicit" | "inferred" | "unknown"; sourceElementIds?:string[] };
export type Poi = {
  id: string; osmType: "node" | "way" | "relation"; osmId: string;
  name: string; named: boolean; names: Record<string, string>; address: string;
  categories: CategoryId[]; description: string; tags: Record<string, string>;
  features: Record<FeatureId, FeatureEvidence>; point: Point; routingPoint: Point;
  routingBasis: "entrance" | "approximate"; parentPoiId: string | null;
  openingHours: string | null; sourceUrl: string; sourceUpdatedAt: string | null;
  datasetVersion: string; sourceIds?:string[]; distanceMeters?: number; score?: number;
};
export type Candidate = Poi & { distanceMeters: number; score: number; categoryFit: number; preferenceFit: number };
export type OpeningState = "open_by_schedule" | "closed_by_schedule" | "unknown";
export type Matrix = { durations: (number | null)[][]; distances: (number | null)[][] };
export type Leg = { fromId: string; toId: string; durationSeconds: number; distanceMeters: number };
export type Stop = { poi: Poi; arrivalAt: string; departureAt: string; visitMinutes: number; openingState: OpeningState; why: string; action: string };
export type Plan = {
  id: string; stops: Stop[]; legs: Leg[]; walkingMinutes: number; visitMinutes: number;
  totalMinutes: number; reserveMinutes: number; returnToStart: boolean;
  geometry: LineString | MultiLineString | null; verified: boolean;
};
export type RecommendationStatus = "ok" | "partial" | "needs_clarification" | "no_matches" | "service_unavailable";
export type CandidateEvaluation = { poiId: string; reason: string };
export type CandidatePoolDiagnostics = {
  radiusMeters: number; candidates: Candidate[]; evaluations: CandidateEvaluation[];
  source: "model" | "fallback" | "not_evaluated"; requestedCount: number;
  rankedPlans: { id: string; poiIds: string[]; walkingMinutes: number }[];
  routeChecks: { planId: string; status: "verified" | "infeasible" | "error" }[];
};
export type Recommendation = {
  status: RecommendationStatus; message: string; intent: SearchIntent | null; origin: Point | null;
  originChoices?: Poi[]; plans: Plan[]; places: Poi[]; unmetConditions: string[];
  datasetVersion: string | null; searchedRadiusMeters: number; explanationSource: "model" | "template";
  selectionSource?: "model" | "fallback";
  diagnostics: { retrieved: number; routed: number; elapsedMs: number; candidatePools?: CandidatePoolDiagnostics[] };
};
export type DataStatus = {
  database: boolean; schemaReady: boolean; openai: boolean; routing: boolean;
  routingProvider?: "ors" | "geoapify";
  dataset: { id: string; snapshotAt: string; publishedAt: string; count: number; tiles: number } | null;
  latestImport: { id: string; status: string; completedTiles: number; totalTiles: number; error: string | null } | null;
  message: string | null;
};
export type CoverageProperties = {
  id: string; count: number; unnamed: number; categories: Partial<Record<CategoryId, number>>;
  withHours: number; withFeatures: number; nearestMeters: Partial<Record<CategoryId, number>>;
  landuse: string[]; state: "populated" | "empty_verified" | "needs_check";
};
export type Coverage = FeatureCollection<Polygon | MultiPolygon, CoverageProperties> & {datasetVersion?:string|null};
export type NormalizedPoi = Omit<Poi, "datasetVersion" | "point" | "routingPoint"> & { geometry: Geometry; routingPoint: Point | null };

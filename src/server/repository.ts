import type { QueryResultRow } from "pg";
import { query } from "./db";
import type { Coverage, DataStatus, Poi } from "@/lib/types";
import { normalizeText } from "@/lib/text";

export type PoiRow = QueryResultRow & {
  id: string; osm_type: Poi["osmType"]; osm_id: string; name: string; named: boolean;
  names: Poi["names"]; address: string; category_ids: Poi["categories"]; description: string;
  tags: Poi["tags"]; features: Poi["features"]; lat: number; lon: number; route_lat: number; route_lon: number;
  routing_basis: Poi["routingBasis"]; parent_poi_id: string | null; opening_hours: string | null;
  source_url: string; source_updated_at: Date | null; run_id: string; source_ids:string[];
};
export const POI_SELECT = `p.*, ST_Y(p.display_point) lat, ST_X(p.display_point) lon,
  ST_Y(p.routing_point) route_lat, ST_X(p.routing_point) route_lon`;
export function toPoi(row: PoiRow): Poi {
  return { id: row.id, osmType: row.osm_type, osmId: row.osm_id, name: row.name, named: row.named,
    names: row.names, address: row.address, categories: row.category_ids, description: row.description,
    tags: row.tags, features: row.features, point: { lat: row.lat, lon: row.lon },
    routingPoint: { lat: row.route_lat, lon: row.route_lon }, routingBasis: row.routing_basis,
    parentPoiId: row.parent_poi_id, openingHours: row.opening_hours, sourceUrl: row.source_url,
    sourceUpdatedAt: row.source_updated_at?.toISOString() ?? null, datasetVersion: row.run_id,sourceIds:row.source_ids?.length?row.source_ids:[row.id] };
}
export async function activeVersion(): Promise<string | null> {
  const rows = await query<{ active_run_id: string | null }>("SELECT active_run_id FROM dataset_state WHERE singleton");
  return rows[0]?.active_run_id ?? null;
}
export async function searchPlaces(text: string, version?: string): Promise<(Poi & { matchScore: number })[]> {
  const term = normalizeText(text);
  if (!term) return [];
  const rows = await query<PoiRow & { match_score: number }>(`
    SELECT ${POI_SELECT}, CASE WHEN p.normalized_name=$1 THEN 3
      WHEN p.search_text LIKE '%' || $1 || '%' THEN 2 ELSE 0 END
      + similarity(p.search_text,$1) + ts_rank_cd(p.search_vector,plainto_tsquery('simple',$1)) AS match_score
    FROM poi p WHERE p.run_id=COALESCE($2::uuid,(SELECT active_run_id FROM dataset_state WHERE singleton))
      AND p.named AND p.duplicate_of IS NULL AND p.public_access AND p.display_point IS NOT NULL
      AND (p.search_text % $1 OR p.search_vector @@ plainto_tsquery('simple',$1) OR p.search_text LIKE '%' || $1 || '%')
    ORDER BY match_score DESC, p.id LIMIT 6`, [term, version ?? null]);
  return rows.map(r => ({ ...toPoi(r), matchScore: r.match_score }));
}
export async function getDataStatus(): Promise<DataStatus> {
  const base: DataStatus = { database: false, schemaReady: false, openai: !!process.env.OPENAI_API_KEY,
    routing: !!process.env.ORS_API_KEY, dataset: null, latestImport: null, message: null };
  if (!process.env.DATABASE_URL && !process.env.LOCAL_DATABASE_PATH) return { ...base, message: "Подключите базу, чтобы загрузить реальные места Астаны." };
  try {
    await query("SELECT 1"); base.database = true;
    const table = await query<{ ready: boolean }>("SELECT to_regclass('public.import_runs') IS NOT NULL ready");
    if (!table[0].ready) return { ...base, message: "Выполните pnpm db:migrate для создания схемы PostGIS." };
    base.schemaReady = true;
    const rows = await query(`SELECT r.id,r.snapshot_at,r.published_at,
      (SELECT count(*)::int FROM active_poi) count,
      (SELECT count(*)::int FROM import_tiles t WHERE t.run_id=r.id AND t.status='complete') tiles
      FROM import_runs r JOIN dataset_state s ON s.active_run_id=r.id`);
    if (rows[0]) base.dataset = { id: rows[0].id, snapshotAt: rows[0].snapshot_at.toISOString(), publishedAt: rows[0].published_at.toISOString(), count: rows[0].count, tiles: rows[0].tiles };
    const latest = await query(`SELECT r.id,r.status,r.error,
      count(t.*) FILTER(WHERE t.status='complete')::int completed,
      count(t.*) FILTER(WHERE t.status<>'split')::int total
      FROM import_runs r LEFT JOIN import_tiles t ON t.run_id=r.id GROUP BY r.id ORDER BY r.created_at DESC LIMIT 1`);
    if (latest[0]) base.latestImport = { id: latest[0].id, status: latest[0].status, error: latest[0].error ? "Загрузка прервана; её можно продолжить." : null, completedTiles: latest[0].completed, totalTiles: latest[0].total };
    if (!base.dataset) base.message = "База готова. Запустите pnpm data:collect для загрузки города.";
    return base;
  } catch { return { ...base, message: "Не удалось подключиться к базе. Проверьте серверные настройки подключения." }; }
}
export async function getCoverage(): Promise<Coverage> {
  const rows = await query(`SELECT id,run_id,ST_AsGeoJSON(geom)::json geometry,properties FROM coverage_cells
    WHERE run_id=(SELECT active_run_id FROM dataset_state WHERE singleton) ORDER BY id`);
  return { type: "FeatureCollection",datasetVersion:rows[0]?.run_id??null,features: rows.map(r => ({ type: "Feature", id: r.id, geometry: r.geometry, properties: r.properties })) };
}

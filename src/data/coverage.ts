import { query,transaction } from "@/server/db";
import { mergeEvidence } from "./merge-evidence";
import { normalizeText } from "@/lib/text";

export async function finalizeGeometry(runId:string){
  await transaction(async client=>{
    await client.query("SET LOCAL statement_timeout='5min'");
    await client.query(`DELETE FROM poi p USING import_runs r WHERE p.run_id=$1 AND r.id=p.run_id
      AND (ST_IsEmpty(p.geom) OR NOT ST_Intersects(p.geom,r.boundary))`,[runId]);
    await client.query(`UPDATE poi p SET display_point=ST_PointOnSurface(ST_Intersection(p.geom,r.boundary)),
      duplicate_of=NULL,parent_poi_id=NULL FROM import_runs r WHERE p.run_id=$1 AND r.id=p.run_id`,[runId]);
    await client.query(`UPDATE poi SET geog=display_point::geography,routing_point=display_point,routing_basis='approximate' WHERE run_id=$1`,[runId]);
    await client.query(`UPDATE poi p SET routing_point=e.geom,routing_basis='entrance' FROM LATERAL
      (SELECT 1) dummy,import_entrances e WHERE p.run_id=$1 AND e.run_id=p.run_id
      AND e.id=(SELECT ent.id FROM import_entrances ent WHERE ent.run_id=p.run_id
        AND ST_DWithin(ent.geom::geography,p.geom::geography,8)
        AND GeometryType(p.geom) IN ('POLYGON','MULTIPOLYGON')
        ORDER BY CASE WHEN ent.tags->>'entrance'='main' THEN 0 ELSE 1 END,ST_Distance(ent.geom,p.display_point),ent.id LIMIT 1)`,[runId]);
    await client.query(`UPDATE poi child SET parent_poi_id=(
      SELECT parent.id FROM poi parent WHERE parent.run_id=child.run_id AND parent.id<>child.id
        AND parent.category_ids && ARRAY['mall','park']::text[] AND GeometryType(parent.geom) IN ('POLYGON','MULTIPOLYGON')
        AND ST_Covers(parent.geom,child.display_point) AND ST_Area(parent.geom::geography)>ST_Area(child.geom::geography)
        ORDER BY ST_Area(parent.geom::geography),parent.id LIMIT 1)
      WHERE child.run_id=$1`,[runId]);
    // Merge only redundant point/polygon representations of the same named venue.
    // A playground in a park and separate branches/floors are not duplicates.
    await client.query(`UPDATE poi node SET duplicate_of=(SELECT area.id FROM poi area
      WHERE area.run_id=node.run_id AND area.id<>node.id AND area.named AND area.normalized_name=node.normalized_name
        AND area.category_ids && node.category_ids AND area.osm_type IN ('way','relation')
        AND GeometryType(area.geom) IN ('POLYGON','MULTIPOLYGON') AND ST_Covers(area.geom,node.display_point)
        AND COALESCE(area.tags->>'level','')=COALESCE(node.tags->>'level','')
        AND (area.address='' OR node.address='' OR area.address=node.address)
        AND ST_Area(area.geom::geography)<100000
      ORDER BY ST_Area(area.geom::geography),area.id LIMIT 1)
      WHERE node.run_id=$1 AND node.osm_type='node' AND node.named`,[runId]);
    await client.query("UPDATE poi SET source_ids=ARRAY[id] WHERE run_id=$1",[runId]);
    const duplicates=await client.query("SELECT id,duplicate_of,tags FROM poi WHERE run_id=$1 AND duplicate_of IS NOT NULL ORDER BY id",[runId]);
    const grouped=new Map<string,{id:string;tags:Record<string,string>}[]>();
    for(const row of duplicates.rows){const sources=grouped.get(row.duplicate_of)??[];sources.push({id:row.id,tags:row.tags});grouped.set(row.duplicate_of,sources);}
    for(const [canonical,sources]of grouped){
      const target=await client.query("SELECT id,tags,name,address FROM poi WHERE run_id=$1 AND id=$2",[runId,canonical]);
      const merged=mergeEvidence([target.rows[0],...sources]);
      await client.query("UPDATE poi SET features=$3,opening_hours=$4,source_ids=$5,public_access=$6,names=$7,search_text=$8,address=$9 WHERE run_id=$1 AND id=$2",[runId,canonical,JSON.stringify(merged.features),merged.openingHours,merged.sourceIds,merged.publicAccess,JSON.stringify(merged.names),normalizeText([...Object.values(merged.names),target.rows[0].name,merged.address].join(" ")),merged.address]);
    }
    await client.query("DELETE FROM route_cache WHERE expires_at<now()");
  });
}
export async function analyzeCoverage(runId:string,preserveVerified=false){
  await transaction(async client=>{
    await client.query("SET LOCAL statement_timeout='5min'");
    const verified=preserveVerified?(await client.query("SELECT id FROM coverage_cells WHERE run_id=$1 AND properties->>'state'='empty_verified'",[runId])).rows.map(r=>r.id):[];
    await client.query("DELETE FROM coverage_cells WHERE run_id=$1",[runId]);
    await client.query(`INSERT INTO coverage_cells(run_id,id,geom,properties)
      WITH grid AS MATERIALIZED (
        SELECT r.id run_id,g.i::text||'_'||g.j::text id,ST_Transform(ST_Intersection(g.geom,ST_Transform(r.boundary,32642)),4326) geom
        FROM import_runs r CROSS JOIN LATERAL ST_SquareGrid(1000,ST_Transform(r.boundary,32642)) g
        WHERE r.id=$1 AND ST_Intersects(g.geom,ST_Transform(r.boundary,32642))
      ), counts AS MATERIALIZED (
        SELECT g.*, (SELECT count(*)::int FROM poi p WHERE p.run_id=g.run_id AND p.public_access AND p.duplicate_of IS NULL AND ST_Covers(g.geom,p.display_point)) n
        FROM grid g WHERE NOT ST_IsEmpty(g.geom) AND ST_Area(g.geom::geography)>0
      ) SELECT g.run_id,g.id,g.geom,jsonb_build_object(
        'id',g.id,'count',g.n,
        'unnamed',(SELECT count(*)::int FROM poi p WHERE p.run_id=g.run_id AND p.public_access AND p.duplicate_of IS NULL AND NOT p.named AND ST_Covers(g.geom,p.display_point)),
        'categories',COALESCE((SELECT jsonb_object_agg(category_id,n) FROM (
          SELECT c.category_id,count(*)::int n FROM poi p JOIN poi_categories c ON c.run_id=p.run_id AND c.poi_id=p.id
          WHERE p.run_id=g.run_id AND p.public_access AND p.duplicate_of IS NULL AND ST_Covers(g.geom,p.display_point) GROUP BY c.category_id) cats),'{}'::jsonb),
        'withHours',(SELECT count(*)::int FROM poi p WHERE p.run_id=g.run_id AND p.public_access AND p.duplicate_of IS NULL AND p.opening_hours IS NOT NULL AND ST_Covers(g.geom,p.display_point)),
        'withFeatures',(SELECT count(*)::int FROM poi p WHERE p.run_id=g.run_id AND p.public_access AND p.duplicate_of IS NULL AND ST_Covers(g.geom,p.display_point)
          AND EXISTS(SELECT 1 FROM jsonb_each(p.features) f WHERE f.value->>'basis'<>'unknown')),
        'nearestMeters',COALESCE((SELECT jsonb_object_agg(cat,distance) FROM (
          SELECT category_id cat,round(min(ST_Distance(ST_PointOnSurface(g.geom)::geography,p.geog)))::int distance
          FROM poi_categories c JOIN poi p ON p.run_id=c.run_id AND p.id=c.poi_id WHERE p.run_id=g.run_id AND p.public_access AND p.duplicate_of IS NULL GROUP BY category_id) nearest),'{}'::jsonb),
        'landuse',COALESCE((SELECT jsonb_agg(DISTINCT l.kind) FROM import_landuse l WHERE l.run_id=g.run_id AND ST_Intersects(l.geom,g.geom)),'[]'::jsonb),
        'state',CASE WHEN g.n>0 THEN 'populated' WHEN g.id=ANY($2::text[]) THEN 'empty_verified' ELSE 'needs_check' END
      ) FROM counts g`,[runId,verified]);
  });
}
export async function auditData(runId?:string){
  const runs=await query("SELECT id,status,snapshot_at FROM import_runs WHERE id=COALESCE($1::uuid,(SELECT active_run_id FROM dataset_state WHERE singleton))",[runId??null]);
  if(!runs.length)throw new Error("Нет выбранной версии датасета");
  const id=runs[0].id;
  const [tiles,counts,coverage,duplicates,categories,urbanCoverage]=await Promise.all([
    query("SELECT status,count(*)::int count FROM import_tiles WHERE run_id=$1 GROUP BY status",[id]),
    query(`SELECT count(*)::int raw,count(*) FILTER(WHERE duplicate_of IS NULL AND public_access)::int usable,
      count(*) FILTER(WHERE NOT named)::int unnamed,count(*) FILTER(WHERE opening_hours IS NOT NULL)::int with_hours,
      count(*) FILTER(WHERE NOT ST_IsValid(geom) OR display_point IS NULL)::int invalid FROM poi WHERE run_id=$1`,[id]),
    query("SELECT properties->>'state' state,count(*)::int count FROM coverage_cells WHERE run_id=$1 GROUP BY properties->>'state'",[id]),
    query("SELECT count(*)::int count FROM poi WHERE run_id=$1 AND duplicate_of IS NOT NULL",[id]),
    query("SELECT c.category_id,count(*)::int count FROM poi_categories c JOIN poi p ON p.run_id=c.run_id AND p.id=c.poi_id WHERE c.run_id=$1 AND p.duplicate_of IS NULL AND p.public_access GROUP BY c.category_id ORDER BY c.category_id",[id]),
    query(`SELECT count(*)::int cells,count(*) FILTER(WHERE (properties->>'count')::int>0)::int with_poi,
      count(*) FILTER(WHERE properties->>'state'='empty_verified')::int empty_verified
      FROM coverage_cells WHERE run_id=$1 AND properties->'landuse' ?| ARRAY['residential','commercial','retail']`,[id])
  ]);
  return {version:id,status:runs[0].status,snapshot:runs[0].snapshot_at,tiles,counts:counts[0],coverage,urbanCoverage:urbanCoverage[0],duplicates:duplicates[0].count,categories,
    passed:!tiles.some(t=>!["complete","split"].includes(t.status))&&!coverage.some(c=>c.state==="needs_check")&&counts[0].invalid===0&&counts[0].usable>0};
}

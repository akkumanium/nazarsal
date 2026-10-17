CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
SET search_path TO public, extensions;

CREATE TABLE IF NOT EXISTS import_runs (
  id uuid PRIMARY KEY, status text NOT NULL CHECK (status IN ('collecting','validating','published','failed')),
  snapshot_at timestamptz NOT NULL, boundary_osm_id text NOT NULL,
  boundary geometry(MultiPolygon,4326) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz,
  error text, config_version text NOT NULL DEFAULT '1'
);
CREATE TABLE IF NOT EXISTS dataset_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  active_run_id uuid REFERENCES import_runs(id)
);
INSERT INTO dataset_state(singleton) VALUES(true) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS import_tiles (
  run_id uuid REFERENCES import_runs(id) ON DELETE CASCADE,
  id text NOT NULL, parent_id text, depth integer NOT NULL DEFAULT 0,
  min_x double precision NOT NULL, min_y double precision NOT NULL,
  max_x double precision NOT NULL, max_y double precision NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','complete','split','failed')),
  attempts integer NOT NULL DEFAULT 0, raw_path text, poi_count integer,
  empty_verified boolean NOT NULL DEFAULT false, error text,
  PRIMARY KEY(run_id,id)
);
CREATE TABLE IF NOT EXISTS poi (
  run_id uuid NOT NULL REFERENCES import_runs(id) ON DELETE CASCADE,
  id text NOT NULL, osm_type text NOT NULL, osm_id text NOT NULL,
  name text NOT NULL, named boolean NOT NULL, names jsonb NOT NULL DEFAULT '{}',
  normalized_name text NOT NULL DEFAULT '', search_text text NOT NULL,
  search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple',search_text)) STORED,
  address text NOT NULL DEFAULT '', description text NOT NULL DEFAULT '',
  tags jsonb NOT NULL, features jsonb NOT NULL, category_ids text[] NOT NULL,
  geom geometry(Geometry,4326) NOT NULL,
  display_point geometry(Point,4326), routing_point geometry(Point,4326),
  geog geography(Point,4326), routing_basis text NOT NULL DEFAULT 'approximate',
  parent_poi_id text, duplicate_of text, public_access boolean NOT NULL DEFAULT true,
  opening_hours text, source_updated_at timestamptz, source_url text NOT NULL,
  PRIMARY KEY(run_id,id), UNIQUE(run_id,osm_type,osm_id)
);
CREATE TABLE IF NOT EXISTS poi_categories (
  run_id uuid NOT NULL, poi_id text NOT NULL, category_id text NOT NULL,
  PRIMARY KEY(run_id,poi_id,category_id),
  FOREIGN KEY(run_id,poi_id) REFERENCES poi(run_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS poi_geog_idx ON poi USING gist(geog);
CREATE INDEX IF NOT EXISTS poi_geometry_idx ON poi USING gist(geom);
CREATE INDEX IF NOT EXISTS poi_category_idx ON poi USING gin(category_ids);
CREATE INDEX IF NOT EXISTS poi_search_idx ON poi USING gin(search_vector);
CREATE INDEX IF NOT EXISTS poi_name_idx ON poi USING gin(search_text gin_trgm_ops);
CREATE INDEX IF NOT EXISTS poi_version_idx ON poi(run_id);
CREATE TABLE IF NOT EXISTS import_landuse (
  run_id uuid REFERENCES import_runs(id) ON DELETE CASCADE, id text NOT NULL,
  kind text NOT NULL, geom geometry(Geometry,4326) NOT NULL,
  PRIMARY KEY(run_id,id)
);
CREATE INDEX IF NOT EXISTS landuse_geom_idx ON import_landuse USING gist(geom);
CREATE TABLE IF NOT EXISTS import_entrances (
  run_id uuid REFERENCES import_runs(id) ON DELETE CASCADE, id text NOT NULL,
  geom geometry(Point,4326) NOT NULL, tags jsonb NOT NULL,
  PRIMARY KEY(run_id,id)
);
CREATE INDEX IF NOT EXISTS entrance_geom_idx ON import_entrances USING gist(geom);
CREATE TABLE IF NOT EXISTS coverage_cells (
  run_id uuid REFERENCES import_runs(id) ON DELETE CASCADE, id text NOT NULL,
  geom geometry(Geometry,4326) NOT NULL, properties jsonb NOT NULL,
  PRIMARY KEY(run_id,id)
);
CREATE TABLE IF NOT EXISTS route_cache (
  cache_key text PRIMARY KEY, dataset_version uuid REFERENCES import_runs(id) ON DELETE CASCADE,
  kind text NOT NULL, payload jsonb NOT NULL, expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS request_budgets (
  bucket text PRIMARY KEY, count integer NOT NULL, expires_at timestamptz NOT NULL
);

-- Runtime responses see only the published version through this view.
CREATE OR REPLACE VIEW active_poi AS
SELECT p.* FROM poi p JOIN dataset_state s ON p.run_id=s.active_run_id
WHERE p.duplicate_of IS NULL AND p.public_access;

-- No direct browser access to raw imports, caches or API budgets on Supabase.
ALTER TABLE import_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE dataset_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_tiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE poi ENABLE ROW LEVEL SECURITY;
ALTER TABLE poi_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_landuse ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_entrances ENABLE ROW LEVEL SECURITY;
ALTER TABLE coverage_cells ENABLE ROW LEVEL SECURITY;
ALTER TABLE route_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE request_budgets ENABLE ROW LEVEL SECURITY;

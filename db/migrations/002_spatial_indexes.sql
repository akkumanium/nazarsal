SET search_path TO public,extensions;
CREATE INDEX IF NOT EXISTS entrance_geography_idx ON import_entrances USING gist((geom::geography));
CREATE INDEX IF NOT EXISTS landuse_version_idx ON import_landuse(run_id);
CREATE INDEX IF NOT EXISTS coverage_version_idx ON coverage_cells(run_id);
CREATE INDEX IF NOT EXISTS import_tile_status_idx ON import_tiles(run_id,status);

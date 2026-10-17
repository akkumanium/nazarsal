SET search_path TO public,extensions;
CREATE INDEX IF NOT EXISTS poi_display_point_idx ON poi USING gist(display_point);

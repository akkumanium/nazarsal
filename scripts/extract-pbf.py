"""Optional full-snapshot OSM adapter. Uses the same exported category catalogue as TS.

Usage: python scripts/extract-pbf.py SOURCE.osm.pbf CATALOG.json OUTPUT.json
Install the pinned helper dependency from scripts/osm-requirements.txt in a venv.
"""
import json
import pathlib
import sys
import os
import gc
import re
import osmium

source, catalog_path, destination = map(pathlib.Path, sys.argv[1:4])
catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
relation_id = int(catalog["boundaryRelationId"])
rules = catalog["rules"]
rule_map = {}
for rule in rules:
    rule_map.setdefault(rule[0], set()).update(rule[1:])
factory = osmium.geom.GeoJSONFactory()
cache_directory = pathlib.Path(__file__).resolve().parent.parent / ".local"
cache_directory.mkdir(parents=True, exist_ok=True)
boundary_cache = cache_directory / f"boundary-nodes-{os.getpid()}.idx"
object_cache = cache_directory / f"object-nodes-{os.getpid()}.idx"


def tags_of(obj):
    return {tag.k: tag.v for tag in obj.tags}


def wanted(tags):
    return any(value in rule_map.get(key, ()) for key, value in tags.items()) or tags.get("landuse") in {
        "residential", "commercial", "retail", "industrial", "recreation_ground"
    } or tags.get("entrance") not in (None, "no")


def coords(geometry):
    def walk(value):
        if isinstance(value[0], (int, float)):
            yield value
        else:
            for item in value:
                yield from walk(item)
    return list(walk(geometry["coordinates"]))


class Boundary(osmium.SimpleHandler):
    feature = None

    def area(self, area):
        if not area.from_way() and area.orig_id() == relation_id:
            self.feature = {"type": "Feature", "id": f"relation/{relation_id}",
                            "geometry": json.loads(factory.create_multipolygon(area)),
                            "properties": {"tags": tags_of(area)}}


print("Extracting complete Astana boundary…", flush=True)
boundary = Boundary()
boundary.apply_file(str(source), locations=True, idx=f"sparse_file_array,{boundary_cache}")
if not boundary.feature:
    raise RuntimeError("The full extract does not contain the assembled Astana boundary")
boundary_feature = boundary.feature
del boundary
gc.collect()
try:
    boundary_cache.unlink(missing_ok=True)
except PermissionError:
    pass  # Windows may keep the mmap handle until process exit; parent cleans up.
points = coords(boundary_feature["geometry"])
box = (min(p[0] for p in points), min(p[1] for p in points), max(p[0] for p in points), max(p[1] for p in points))


def outside_box(bounds):
    return bounds[2] < box[0] or bounds[0] > box[2] or bounds[3] < box[1] or bounds[1] > box[3]


class RelationBounds(osmium.SimpleHandler):
    """Locate even a broken area from all of its original member-way nodes.

    A malformed park elsewhere in Kazakhstan must not be mistaken for an
    incomplete city import. Unknown or in-city failures remain fatal.
    """
    def __init__(self):
        super().__init__()
        self.relation_ways = {}
        self.way_relations = {}
        self.seen = set()
        self.bounds = {}

    def relation(self, relation):
        if not wanted(tags_of(relation)):
            return
        refs = {member.ref for member in relation.members if member.type == "w"}
        self.relation_ways[relation.id] = refs
        for ref in refs:
            self.way_relations.setdefault(ref, set()).add(relation.id)

    def way(self, way):
        if way.id not in self.way_relations:
            return
        if not len(way.nodes) or any(not node.location.valid() for node in way.nodes):
            return
        points = [(node.lon, node.lat) for node in way.nodes]
        self.seen.add(way.id)
        bounds = (min(p[0] for p in points), min(p[1] for p in points), max(p[0] for p in points), max(p[1] for p in points))
        for relation in self.way_relations[way.id]:
            old = self.bounds.get(relation, bounds)
            self.bounds[relation] = (min(old[0], bounds[0]), min(old[1], bounds[1]), max(old[2], bounds[2]), max(old[3], bounds[3]))

    def proven_outside(self, relation):
        refs = self.relation_ways.get(relation)
        return bool(refs) and refs.issubset(self.seen) and relation in self.bounds and outside_box(self.bounds[relation])


relation_bounds = RelationBounds()
for relation in (osmium.FileProcessor(str(source), osmium.osm.RELATION)
                 .with_filter(osmium.filter.KeyFilter(*rule_map.keys(), "landuse"))):
    relation_bounds.relation(relation)


def intersects_box(geometry):
    points = coords(geometry)
    return points and max(p[0] for p in points) >= box[0] and min(p[0] for p in points) <= box[2] and max(p[1] for p in points) >= box[1] and min(p[1] for p in points) <= box[3]


class Extract(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.features = {}
        self.pending_areas = set()
        self.errors = []

    def save(self, obj, kind, object_id, geometry):
        if intersects_box(geometry):
            feature_id = f"{kind}/{object_id}"
            self.features[feature_id] = {"type": "Feature", "id": feature_id, "geometry": geometry,
                                         "properties": {"tags": tags_of(obj), "meta": {"timestamp": str(obj.timestamp)}}}

    def node(self, node):
        if not len(node.tags):
            return
        tags = tags_of(node)
        if wanted(tags) and node.location.valid() and box[0] <= node.lon <= box[2] and box[1] <= node.lat <= box[3]:
            self.save(node, "node", node.id, {"type": "Point", "coordinates": [node.lon, node.lat]})

    def way(self, way):
        relation_bounds.way(way)
        if not wanted(tags_of(way)):
            return
        try:
            geometry = json.loads(factory.create_linestring(way))
            if not intersects_box(geometry):
                return
            if way.is_closed() and way.tags.get("area") != "no":
                self.pending_areas.add(way.id)
            else:
                self.save(way, "way", way.id, geometry)
        except Exception as error:
            self.errors.append(f"way/{way.id}: {error}")

    def area(self, area):
        kind = "way" if area.from_way() else "relation"
        self.pending_areas.discard(area.orig_id()) if area.from_way() else None
        if area.from_way() and area.tags.get("area") == "no":
            return
        if not wanted(tags_of(area)):
            return
        locations = [(node.lon, node.lat) for ring in area.outer_rings() for node in ring if node.location.valid()]
        if locations and (max(p[0] for p in locations) < box[0] or min(p[0] for p in locations) > box[2]
                          or max(p[1] for p in locations) < box[1] or min(p[1] for p in locations) > box[3]):
            return
        try:
            self.save(area, kind, area.orig_id(), json.loads(factory.create_multipolygon(area)))
        except Exception as error:
            self.errors.append(f"{kind}/{area.orig_id()}: {error}")


print("Reading all nodes, ways and assembled areas from the country snapshot…", flush=True)
extract = Extract()
processed = 0
# Native filters run AFTER location storage and area assembly. References remain
# complete, while millions of non-POI objects never cross into Python.
processor = (osmium.FileProcessor(str(source)).with_locations(f"sparse_file_array,{object_cache}").with_areas()
             .with_filter(osmium.filter.KeyFilter(*rule_map.keys(), "landuse", "entrance"))
             .handler_for_filtered(relation_bounds))
for obj in processor:
    if obj.is_node():
        extract.node(obj)
    elif obj.is_way():
        extract.way(obj)
    elif obj.is_area():
        extract.area(obj)
    processed += 1
    if processed % 100000 == 0:
        print(f"Scanned {processed} tagged candidates; selected {len(extract.features)} objects in the city envelope", flush=True)
del processor
gc.collect()
try:
    object_cache.unlink(missing_ok=True)
except PermissionError:
    pass
outside_errors, unresolved_errors = [], []
for error in extract.errors:
    match = re.match(r"relation/(\d+):", error)
    (outside_errors if match and relation_bounds.proven_outside(int(match.group(1))) else unresolved_errors).append(error)
if extract.pending_areas or unresolved_errors:
    raise RuntimeError(f"Incomplete city geometries: {len(extract.pending_areas)} unassembled ways; {unresolved_errors[:5]}")
reader = osmium.io.Reader(str(source))
snapshot = reader.header().get("osmosis_replication_timestamp")
reader.close()
if not snapshot:
    raise RuntimeError("PBF has no replication timestamp")
output = {"type": "FeatureCollection", "metadata": {"snapshot": snapshot, "source": "Geofabrik / OpenStreetMap", "completeExtract": True,
          "temporaryIndexes": [str(boundary_cache), str(object_cache)]},
          "boundary": boundary_feature, "features": list(extract.features.values())}
temporary = destination.with_suffix(".tmp")
temporary.write_text(json.dumps(output, ensure_ascii=False), encoding="utf-8")
temporary.replace(destination)
print(f"Extracted {len(extract.features)} objects, snapshot {snapshot}", flush=True)

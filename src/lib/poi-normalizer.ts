import type { Feature, Geometry } from "geojson";
import { CATEGORIES, FEATURE_IDS, categoryIdsForTags } from "./catalog";
import type { FeatureEvidence, NormalizedPoi } from "./types";

const unknown = (): FeatureEvidence => ({ value: null, tag: null, basis: "unknown" });
export function namesFromTags(tags:Record<string,string>):Record<string,string>{
  return Object.fromEntries(Object.entries(tags).filter(([key]) => ["name", "alt_name", "old_name", "short_name", "official_name"].includes(key) || key.startsWith("name:")));
}
export function extractFeatures(tags: Record<string, string>): NormalizedPoi["features"] {
  const features = Object.fromEntries(FEATURE_IDS.map(id => [id, unknown()])) as NormalizedPoi["features"];
  const set = (key: keyof typeof features, value: FeatureEvidence["value"], tag: string, basis: FeatureEvidence["basis"] = "explicit") => { features[key] = { value, tag, basis }; };
  const electricity = tags["service:electricity"];
  if (electricity === "yes") set("power_outlets", true, "service:electricity=yes");
  else if (electricity === "no") set("power_outlets", false, "service:electricity=no");
  else if (["limited", "ask"].includes(electricity)) set("power_outlets", electricity, `service:electricity=${electricity}`);
  else if (["yes", "no"].includes(tags.power_supply)) set("power_outlets", tags.power_supply === "yes", `power_supply=${tags.power_supply}`);
  else if (tags.amenity === "cafe" || tags.amenity === "restaurant" || tags.amenity === "library") {
    const socket = Object.entries(tags).find(([k,v]) => /^socket:[^:]+$/.test(k) && (v === "yes" || Number(v) > 0));
    if (socket) set("power_outlets", true, `${socket[0]}=${socket[1]}`);
  }
  if (["wlan", "yes"].includes(tags.internet_access)) set("wifi", true, `internet_access=${tags.internet_access}`);
  if (tags.internet_access === "no") set("wifi", false, "internet_access=no");
  if (["yes", "no", "limited"].includes(tags.wheelchair)) set("wheelchair", tags.wheelchair === "limited" ? "limited" : tags.wheelchair === "yes", `wheelchair=${tags.wheelchair}`);
  if (["yes", "no"].includes(tags.fee)) set("free_entry", tags.fee === "no", `fee=${tags.fee}`);
  if (["yes", "no"].includes(tags.indoor)) set("indoor", tags.indoor === "yes", `indoor=${tags.indoor}`);
  if (["yes", "no"].includes(tags["child_friendly"])) set("child_friendly", tags.child_friendly === "yes", `child_friendly=${tags.child_friendly}`);
  if (tags.leisure === "playground" || tags.leisure === "trampoline_park") set("child_friendly", true, `leisure=${tags.leisure}`);
  return features;
}
export function hasPublicAccess(tags: Record<string, string>): boolean {
  if (["no", "private", "military"].includes(tags.access) || tags.foot === "no") return false;
  if (["yes", "true", "1"].includes(tags.disused) || ["yes", "true", "1"].includes(tags.abandoned)) return false;
  if (tags.shop === "vacant" || tags.amenity === "construction" || tags.construction === "yes") return false;
  return true;
}
export function normalizeOsmFeature(feature: Feature<Geometry>, raw?: { tags?: Record<string,string>; timestamp?: string }): NormalizedPoi | null {
  const props = feature.properties ?? {};
  const tags = raw?.tags ?? props.tags ?? props;
  const id = String(feature.id ?? props.id ?? "");
  const match = /^(node|way|relation)\/(\d+)$/.exec(id);
  if (!match || !feature.geometry) return null;
  const categories = categoryIdsForTags(tags);
  if (!categories.length) return null;
  const names = namesFromTags(tags);
  const name = tags["name:ru"] || tags.name || tags["name:kk"] || tags["name:en"] || CATEGORIES[categories[0]].singular;
  const address = [tags["addr:street"], tags["addr:housenumber"]].filter(Boolean).join(", ") || tags["addr:full"] || "";
  const geometry = feature.geometry;
  return { id, osmType: match[1] as NormalizedPoi["osmType"], osmId: match[2], name, named: Object.keys(names).length > 0,
    names, address, categories, description: tags["description:ru"] || tags.description || `${CATEGORIES[categories[0]].singular}${address ? `, ${address}` : ""}.`,
    tags, features: extractFeatures(tags), geometry, routingPoint: null, routingBasis: "approximate", parentPoiId: null,
    openingHours: tags.opening_hours ?? null, sourceUrl: `https://www.openstreetmap.org/${id}`,
    sourceUpdatedAt: raw?.timestamp ?? props.meta?.timestamp ?? null };
}

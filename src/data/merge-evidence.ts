import { extractFeatures,hasPublicAccess,namesFromTags } from "@/lib/poi-normalizer";
import { FEATURE_IDS } from "@/lib/catalog";
import type { FeatureEvidence } from "@/lib/types";

export function mergeEvidence(records:{id:string;tags:Record<string,string>}[]){
  const features=extractFeatures(records[0].tags);
  let hours=records[0].tags.opening_hours??null,hoursConflict=false;
  const conflicts=new Set<string>();
  for(const feature of FEATURE_IDS)if(features[feature].value!==null)features[feature].sourceElementIds=[records[0].id];
  for(const record of records.slice(1)){
    const next=extractFeatures(record.tags);
    for(const feature of FEATURE_IDS){
      const incoming=next[feature],existing=features[feature];
      if(incoming.value===null)continue;
      if(conflicts.has(feature)){existing.sourceElementIds=[...new Set([...(existing.sourceElementIds??[]),record.id])];continue;}
      if(existing.value===null)features[feature]={...incoming,sourceElementIds:[record.id]};
      else if(existing.value===incoming.value)existing.sourceElementIds=[...new Set([...(existing.sourceElementIds??[]),record.id])];
      else{conflicts.add(feature);features[feature]={value:null,tag:"conflicting OSM representations",basis:"unknown",sourceElementIds:[...(existing.sourceElementIds??[]),record.id]} satisfies FeatureEvidence;}
    }
    if(record.tags.opening_hours){
      if(hours&&hours!==record.tags.opening_hours)hoursConflict=true;
      if(!hours&&!hoursConflict)hours=record.tags.opening_hours;
    }
  }
  const names=records.reduce((merged,record)=>({...namesFromTags(record.tags),...merged}),{} as Record<string,string>);
  const address=records.map(r=>[r.tags["addr:street"],r.tags["addr:housenumber"]].filter(Boolean).join(", ")||r.tags["addr:full"]||"").find(Boolean)||"";
  return {features,openingHours:hoursConflict?null:hours,sourceIds:records.map(r=>r.id),publicAccess:records.every(r=>hasPublicAccess(r.tags)),names,address};
}

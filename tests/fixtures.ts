import type { Candidate,Matrix } from "../src/lib/types";
import type { CategoryId } from "../src/lib/catalog";
import type { SearchIntent } from "../src/lib/intent";
import { extractFeatures } from "../src/lib/poi-normalizer";

// Synthetic fixtures, never loaded into the application's POI dataset.
export function candidate(id:string,category:CategoryId="coffee",extra:Partial<Candidate>={}):Candidate{
  const tags={amenity:"cafe",opening_hours:"24/7"};
  return {id:`node/${id}`,osmType:"node",osmId:id,name:`Тестовый объект ${id}`,named:true,names:{name:`Тестовый объект ${id}`},address:"",
    categories:[category],description:"Тестовый объект",tags,features:extractFeatures(tags),point:{lat:51.1282,lon:71.4304},routingPoint:{lat:51.1282,lon:71.4304},routingBasis:"entrance",parentPoiId:null,
    openingHours:"24/7",sourceUrl:`https://www.openstreetmap.org/node/${id}`,sourceUpdatedAt:null,datasetVersion:"00000000-0000-4000-8000-000000000001",distanceMeters:100,score:.8,categoryFit:1,preferenceFit:.5,...extra};
}
export function intent(extra:Partial<SearchIntent>={}):SearchIntent{
  return {mode:"itinerary",originQuery:null,durationMinutes:60,maxWalkingMinutes:null,maxRadiusMeters:null,returnToStart:false,
    goals:[{categoryIds:["coffee"],priority:"primary",required:true}],excludedCategoryIds:[],constraints:[],unresolvedPreferences:[],clarification:null,...extra};
}
export function matrix(size:number,seconds=300):Matrix{
  return {durations:Array.from({length:size},(_,a)=>Array.from({length:size},(_,b)=>a===b?0:seconds)),distances:Array.from({length:size},(_,a)=>Array.from({length:size},(_,b)=>a===b?0:400))};
}

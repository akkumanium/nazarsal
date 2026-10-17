import { CATEGORIES, type CategoryId } from "@/lib/catalog";
import type { SearchIntent } from "@/lib/intent";
import type { Candidate, Leg, Matrix, OpeningState, Plan, Point, Stop } from "@/lib/types";
import { openingState } from "./opening-hours";
import { fitsMust } from "./candidate-search";
import type { DirectionsResult } from "./routing";

export function reserveMinutes(intent:SearchIntent){return Math.max(5,(intent.durationMinutes??60)*.1);}
function visitRange(poi:Candidate,intent:SearchIntent):[number,number]{
  const preferred=intent.goals.flatMap(g=>g.categoryIds).find(c=>poi.categories.includes(c));
  return CATEGORIES[preferred??poi.categories[0]].visit;
}
function satisfiesGoals(pois:Candidate[],intent:SearchIntent):boolean{
  if(intent.mode==="alternatives")return intent.goals.filter(g=>g.required).every(g=>pois.some(p=>p.categories.some(c=>g.categoryIds.includes(c))));
  let cursor=0;
  for(const goal of intent.goals.filter(g=>g.required)){
    const index=pois.findIndex((p,i)=>i>=cursor&&p.categories.some(c=>goal.categoryIds.includes(c)));
    if(index<0)return false;cursor=index+1;
  }
  return true;
}
function requiredOpening(state:OpeningState,intent:SearchIntent){
  return intent.constraints.filter(c=>c.feature==="open_now"&&c.strength==="must").every(c=>c.operator==="eq"&&typeof c.value==="boolean"&&state===(c.value?"open_by_schedule":"closed_by_schedule"));
}
export function evaluateSequence(indices:number[],candidates:Candidate[],matrix:Matrix,intent:SearchIntent,start:Date,visits?:number[]):Plan|null{
  const pois=indices.map(i=>candidates[i]);
  if(!pois.length||pois.some(p=>!fitsMust(p,intent))||!satisfiesGoals(pois,intent))return null;
  if(new Set(pois.map(p=>p.id)).size!==pois.length)return null;
  if(pois.some(p=>pois.some(other=>other.id===p.parentPoiId&&other.categories.some(c=>p.categories.includes(c)))))return null;
  let time=start.getTime(),last=0;
  const legs:Leg[]=[],stops:Stop[]=[];
  for(let i=0;i<indices.length;i++){
    const next=indices[i]+1,seconds=matrix.durations[last]?.[next],distance=matrix.distances[last]?.[next];
    if(seconds==null||distance==null||!Number.isFinite(seconds)||!Number.isFinite(distance))return null;
    legs.push({fromId:i===0?"origin":pois[i-1].id,toId:pois[i].id,durationSeconds:seconds,distanceMeters:distance});
    time+=seconds*1000;
    const visitMinutes=visits?.[i]??visitRange(pois[i],intent)[0];
    const end=new Date(time+visitMinutes*60000),state=openingState(pois[i],new Date(time),end);
    // A visit known to overlap closing time is not feasible. Unknown is shown explicitly.
    if(state==="closed_by_schedule"||!requiredOpening(state,intent))return null;
    stops.push({poi:pois[i],arrivalAt:new Date(time).toISOString(),departureAt:end.toISOString(),visitMinutes,openingState:state,why:"",action:""});
    time=end.getTime();last=next;
  }
  if(intent.returnToStart){
    const seconds=matrix.durations[last]?.[0],distance=matrix.distances[last]?.[0];
    if(seconds==null||distance==null)return null;
    legs.push({fromId:pois.at(-1)!.id,toId:"origin",durationSeconds:seconds,distanceMeters:distance});time+=seconds*1000;
  }
  const walkingMinutes=legs.reduce((s,l)=>s+l.durationSeconds/60,0),visitMinutes=stops.reduce((s,p)=>s+p.visitMinutes,0);
  const reserve=reserveMinutes(intent),total=walkingMinutes+visitMinutes+reserve;
  if(total>(intent.durationMinutes??60)+1e-8||walkingMinutes>(intent.maxWalkingMinutes??Infinity))return null;
  return {id:pois.map(p=>p.id).join("~"),stops,legs,walkingMinutes,visitMinutes,totalMinutes:total,reserveMinutes:reserve,returnToStart:intent.returnToStart,geometry:null,verified:false};
}
function planRank(plan:Plan,intent:SearchIntent):number[]{
  const ids=new Set(plan.stops.flatMap(s=>s.poi.categories));
  const coverage=intent.goals.reduce((sum,g)=>sum+(g.categoryIds.some(c=>ids.has(c))?(g.priority==="primary"?1:.5):0),0);
  const preference=plan.stops.reduce((sum,s)=>sum+(s.poi as Candidate).preferenceFit,0)/plan.stops.length;
  return [coverage,preference,-plan.walkingMinutes,-plan.stops.length];
}
export function comparePlans(a:Plan,b:Plan,intent:SearchIntent):number{
  const ar=planRank(a,intent),br=planRank(b,intent);
  for(let i=0;i<ar.length;i++){if(Math.abs(ar[i]-br[i])>1e-8)return br[i]-ar[i];}
  return a.id.localeCompare(b.id);
}
export function enumeratePlans(candidates:Candidate[],matrix:Matrix,intent:SearchIntent,start:Date):Plan[]{
  const result:Plan[]=[];
  const max=intent.mode==="alternatives"?1:3;
  function visit(path:number[]){
    if(path.length){const plan=evaluateSequence(path,candidates,matrix,intent,start);if(plan)result.push(plan);}
    if(path.length===max)return;
    for(let i=0;i<candidates.length;i++)if(!path.includes(i))visit([...path,i]);
  }
  visit([]);
  return result.sort((a,b)=>comparePlans(a,b,intent));
}
export function revalidateDirections(plan:Plan,directions:DirectionsResult,candidates:Candidate[],intent:SearchIntent,start:Date):Plan|null{
  if(directions.segments.length!==plan.legs.length)return null;
  const n=candidates.length+1;
  const matrix:Matrix={durations:Array.from({length:n},()=>Array<number|null>(n).fill(null)),distances:Array.from({length:n},()=>Array<number|null>(n).fill(null))};
  const indices=plan.stops.map(s=>candidates.findIndex(p=>p.id===s.poi.id));
  if(indices.some(i=>i<0))return null;
  const nodes=[0,...indices.map(i=>i+1),...(intent.returnToStart?[0]:[])];
  directions.segments.forEach((s,i)=>{matrix.durations[nodes[i]][nodes[i+1]]=s.duration;matrix.distances[nodes[i]][nodes[i+1]]=s.distance;});
  let verified=evaluateSequence(indices,candidates,matrix,intent,start);
  if(!verified)return null;
  // Add meaningful visit time only while the full schedule and budget remain valid.
  let visits=verified.stops.map(s=>s.visitMinutes);
  for(let i=0;i<indices.length;i++){
    const range=visitRange(candidates[indices[i]],intent),target=Math.round((range[0]+range[1])/2);
    for(let amount=target;amount>visits[i];amount--){
      const expanded=[...visits];expanded[i]=amount;
      const attempt=evaluateSequence(indices,candidates,matrix,intent,start,expanded);
      if(attempt){verified=attempt;visits=expanded;break;}
    }
  }
  return {...verified,geometry:directions.geometry,verified:true};
}
export function routePoints(plan:Plan,origin:Point):Point[]{return [origin,...plan.stops.map(s=>s.poi.routingPoint),...(plan.returnToStart?[origin]:[])];}
export function missingGoals(plans:Plan[],intent:SearchIntent):string[]{
  const categories=new Set<CategoryId>(plans.flatMap(p=>p.stops.flatMap(s=>s.poi.categories)));
  return intent.goals.filter(g=>!g.categoryIds.some(c=>categories.has(c))).map(g=>`Не удалось включить: ${g.categoryIds.map(c=>CATEGORIES[c].label).join(" или ")}.`);
}

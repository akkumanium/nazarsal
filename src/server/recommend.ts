import type { RecommendRequest, SearchIntent } from "@/lib/intent";
import { withDefaults } from "@/lib/intent";
import { FEATURE_LABELS } from "@/lib/catalog";
import type { Candidate, CandidatePoolDiagnostics, Plan, Point, Recommendation } from "@/lib/types";
import { activeVersion, searchPlaces } from "./repository";
import { parseIntent, selectRecommendations, writeRecommendation } from "./openai";
import { featureMatches, findCandidates, searchRadii, selectDiverseCandidates } from "./candidate-search";
import { enumeratePlans, missingGoals, revalidateDirections, routePoints, selectPlanOptions } from "./route-planner";
import { RoutingError, routeDirections, routeMatrix } from "./routing";
import { ConfigurationError } from "./db";

export async function recommend(request:RecommendRequest):Promise<Recommendation>{
  const began=Date.now();
  let version:string|null=null,intent:SearchIntent|null=null,origin:Point|null=request.origin??null;
  let originPoiId:string|undefined;
  const candidatePools:CandidatePoolDiagnostics[]=[];
  const response=(patch:Partial<Recommendation>):Recommendation=>({status:"no_matches",message:"Подходящих мест не найдено.",intent,origin,plans:[],places:[],unmetConditions:[],datasetVersion:version,searchedRadiusMeters:0,explanationSource:"template",...patch,
    diagnostics:{retrieved:0,routed:0,elapsedMs:Date.now()-began,...patch.diagnostics,...(process.env.NODE_ENV!=="production"?{candidatePools}:{})}});
  try{
    version=await activeVersion();
    if(!version)return response({status:"service_unavailable",message:"Сначала загрузите реальные POI: pnpm data:collect."});
    const travelMode=request.travelMode??request.previousIntent?.travelMode??"walk";
    intent={...withDefaults(await parseIntent(request.query,request.previousIntent??null,request.language,travelMode),request.controls),travelMode};
    if(intent.clarification)return response({status:"needs_clarification",message:intent.clarification});
    if(intent.originQuery&&!(request.confirmedOriginQuery===intent.originQuery&&request.origin)){
      const choices=await searchPlaces(intent.originQuery,version);
      if(!choices.length)return response({status:"needs_clarification",message:`Не нашли ориентир «${intent.originQuery}». Выберите точку на карте.`});
      if(choices.length>1&&choices[0].matchScore-choices[1].matchScore<.35)return response({status:"needs_clarification",message:"Уточните, какой ориентир вы имели в виду.",originChoices:choices});
      origin={...choices[0].point,label:choices[0].name};
      originPoiId=choices[0].id;
    }
    if(!origin)return response({status:"needs_clarification",message:"Выберите старт на карте или разрешите доступ к геолокации."});
    const start=request.startAt?new Date(request.startAt):new Date();
    if(Math.abs(start.getTime()-Date.now())>14*86400000)return response({status:"needs_clarification",message:"Выберите время начала в пределах ближайших двух недель."});
    const radii=searchRadii(intent);
    let candidates:Candidate[]=[],retrieved=0,radius=0;
    const verified:Plan[]=[];
    let selectionSource:"model"|"fallback"|undefined;
    let routeFailure=false,matrixCalls=0,directionAttempts=0;
    let routeFailureMessage="Не удалось проверить маршруты.";
    let previousIds="";
    for(let radiusIndex=0;radiusIndex<radii.length;radiusIndex++){
      const r=radii[radiusIndex];
      radius=r;
      const found=await findCandidates(intent,origin,r,version,request.excludedPoiIds,start);retrieved=found.length;
      if(!found.length)continue;
      candidates=selectDiverseCandidates(found,intent);
      const candidateIds=candidates.map(p=>p.id).join("|");
      if(candidateIds===previousIds)continue;previousIds=candidateIds;
      if(matrixCalls>=2)break;matrixCalls++;
      const pool:CandidatePoolDiagnostics={radiusMeters:r,candidates,evaluations:[],source:"not_evaluated",requestedCount:0,rankedPlans:[],routeChecks:[]};
      candidatePools.push(pool);
      let plans:Plan[];
      try{
        const matrix=await routeMatrix(origin,candidates.map(p=>p.routingPoint),candidates.map(p=>p.id),version,originPoiId,travelMode);
        plans=enumeratePlans(candidates,matrix,intent,start);
      }catch(error){if(error instanceof ConfigurationError)throw error;routeFailure=true;if(error instanceof RoutingError)routeFailureMessage=error.message;break;}
      if(!plans.length){
        if(matrixCalls===1&&radiusIndex<radii.length-2)radiusIndex=radii.length-2;
        continue;
      }
      const selection=await selectRecommendations(selectPlanOptions(plans,candidates),candidates,intent,request.query,request.language);
      selectionSource=selection.source;
      pool.source=selection.source;pool.evaluations=selection.evaluations;pool.requestedCount=selection.count;
      pool.rankedPlans=selection.plans.map(p=>({id:p.id,poiIds:p.stops.map(s=>s.poi.id),travelMinutes:p.travelMinutes}));
      for(const plan of selection.plans){
        if(verified.length>=selection.count||directionAttempts>=6)break;
        if(verified.some(p=>p.stops[0].poi.id===plan.stops[0].poi.id)&&intent.mode==="alternatives")continue;
        directionAttempts++;
        try{
          const result=await routeDirections(routePoints(plan,origin),120,travelMode);
          const checked=revalidateDirections(plan,result,candidates,intent,start);
          pool.routeChecks.push({planId:plan.id,status:checked?"verified":"infeasible"});
          if(checked)verified.push(checked);
        }catch(error){pool.routeChecks.push({planId:plan.id,status:"error"});if(error instanceof ConfigurationError)throw error;routeFailure=true;if(error instanceof RoutingError)routeFailureMessage=error.message;}
      }
      if(verified.length||directionAttempts>=6)break;
      // One expansion after a failed route should cover the remaining allowed
      // area, rather than spend both matrix calls on two nearly identical rings.
      if(matrixCalls===1&&radiusIndex<radii.length-2)radiusIndex=radii.length-2;
    }
    const diagnostics={retrieved,routed:candidates.length,elapsedMs:Date.now()-began};
    if(!verified.length)return response({status:routeFailure?"service_unavailable":"no_matches",
      message:routeFailure?`${routeFailureMessage} Показываем найденные места без расчёта времени и маршрута.`:"Не нашли выполнимый вариант со всеми обязательными условиями. Можно изменить длительность или явно ослабить одно из условий.",
      places:routeFailure?candidates.slice(0,3):[],searchedRadiusMeters:radius,diagnostics,
      unmetConditions:intent.constraints.filter(c=>c.strength==="must").map(c=>`Обязательное условие: ${FEATURE_LABELS[c.feature]}`)});
    const unmet=[...intent.unresolvedPreferences,...missingGoals(verified,intent)];
    if(selectionSource==="fallback")unmet.push("ИИ-отбор сейчас недоступен. Варианты выбраны резервным алгоритмом по соответствию условиям и расстоянию.");
    for(const constraint of intent.constraints.filter(c=>c.strength==="prefer")){
      const states=verified.flatMap(p=>p.stops.map(s=>constraint.feature==="open_now"?(s.openingState==="unknown"?null:(s.openingState==="open_by_schedule")===constraint.value):featureMatches(s.poi.features[constraint.feature],constraint.operator,constraint.value)));
      if(states.some(s=>s!==true))unmet.push(`${FEATURE_LABELS[constraint.feature]}: ${states.includes(null)?"не у всех мест есть подтверждение":"пожелание выполнено не для всех остановок"}.`);
    }
    if(verified.some(p=>p.stops.some(s=>s.openingState==="unknown")))unmet.push("Для части мест режим работы не подтверждён. Уточните доступ перед посещением.");
    if(verified.some(p=>p.stops.some(s=>s.poi.routingBasis==="approximate")))unmet.push("Подход рассчитан к приблизительной точке объекта; расположение входа может отличаться.");
    const written=await writeRecommendation(verified,intent,request.query,request.language);
    return response({status:unmet.length?"partial":"ok",message:written.summary,plans:written.plans,unmetConditions:[...new Set(unmet)],searchedRadiusMeters:radius,
      explanationSource:written.source,selectionSource,diagnostics:{...diagnostics,elapsedMs:Date.now()-began}});
  }catch(error){
    return response({status:"service_unavailable",message:error instanceof ConfigurationError?error.message:"Не удалось завершить поиск. Проверьте подключения и повторите запрос."});
  }
}

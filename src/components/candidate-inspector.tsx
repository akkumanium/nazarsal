"use client";

import { useId, useRef } from "react";
import { CATEGORIES, FEATURE_LABELS, type FeatureId } from "@/lib/catalog";
import type { Recommendation } from "@/lib/types";

export function CandidateInspector({result}:{result:Recommendation}){
  const dialog=useRef<HTMLDialogElement>(null);
  const titleId=useId();
  const pools=result.diagnostics.candidatePools;
  if(!pools?.length)return null;
  const selected=new Set(result.plans.flatMap(p=>p.stops.map(s=>s.poi.id)));
  return <>
    <button className="candidate-dev-button" onClick={()=>dialog.current?.showModal()}>Dev · Кандидаты ({pools.at(-1)!.candidates.length})</button>
    <dialog className="candidate-inspector" ref={dialog} aria-labelledby={titleId} onClick={e=>{if(e.target===e.currentTarget)dialog.current?.close();}}>
      <header><div><small>DEV · ДИАГНОСТИКА ОТБОРА</small><h2 id={titleId}>Все кандидаты</h2></div><button autoFocus className="icon-button" aria-label="Закрыть кандидатов" onClick={()=>dialog.current?.close()}>×</button></header>
      <p>До 12 мест в каждой поисковой выборке. ИИ оценивает весь список и выбирает 1–3 варианта; для прогулки — один готовый маршрут. Подробный путь проверяется после выбора.</p>
      {pools.map((pool,index)=><section className="candidate-pool" key={`${index}-${pool.radiusMeters}`}>
        <h3>Выборка {index+1} · {pool.radiusMeters} м · {pool.candidates.length} мест</h3>
        <p>{pool.source==="model"?`Отбор: ИИ · запрошено вариантов: ${pool.requestedCount}`:pool.source==="fallback"?"Отбор: резервный алгоритм (ИИ недоступен или вернул некорректный ответ)":"ИИ ещё не оценивал выборку: нет допустимых маршрутов или недоступен сервис путей."}</p>
        <ol className="candidate-list">{pool.candidates.map(p=>{
          const evaluation=pool.evaluations.find(e=>e.poiId===p.id);
          const plans=pool.rankedPlans.filter(plan=>plan.poiIds.includes(p.id));
          const checks=pool.routeChecks.filter(check=>plans.some(plan=>plan.id===check.planId));
          const chosen=selected.has(p.id)&&checks.some(check=>check.status==="verified");
          return <li key={p.id} className={chosen?"candidate-chosen":""}>
            <div className="candidate-title"><a href={p.sourceUrl} target="_blank" rel="noreferrer">{p.name}</a><span>{chosen?"В результате":plans.length?"В пуле маршрутов":"Нет допустимого маршрута"}</span></div>
            <p>{p.categories.map(c=>CATEGORIES[c].label).join(" · ")} · {Math.round(p.distanceMeters)} м по прямой</p>
            {p.address&&<p>{p.address}</p>}
            {p.description&&<p>{p.description}</p>}
            <p className="candidate-evaluation">{evaluation?`Оценка ИИ: ${evaluation.reason}`:"Оценка ИИ отсутствует."}</p>
            {plans.length>0&&<p>Позиции маршрутов в рейтинге: {plans.map(plan=>pool.rankedPlans.indexOf(plan)+1).join(", ")}</p>}
            {checks.length>0&&<p>Проверка пути: {checks.map(check=>check.status==="verified"?"подтверждён":check.status==="infeasible"?"не укладывается в условия":"ошибка сервиса").join(" · ")}</p>}
            <details><summary>Данные кандидата · {p.id}</summary>
              <p>Оценка скрипта: {p.score.toFixed(3)} · соответствие категории: {p.categoryFit.toFixed(3)} · пожеланиям: {p.preferenceFit.toFixed(3)}</p>
              <p>Часы работы: {p.openingHours??"неизвестны"}</p>
              <dl>{Object.entries(p.features).map(([id,fact])=><div key={id}><dt>{FEATURE_LABELS[id as FeatureId]}</dt><dd>{fact.value===null?"неизвестно":String(fact.value)} · {fact.basis}{fact.tag?` · ${fact.tag}`:""}</dd></div>)}</dl>
              <pre>{JSON.stringify(p.tags,null,2)}</pre>
            </details>
          </li>;
        })}</ol>
      </section>)}
    </dialog>
  </>;
}

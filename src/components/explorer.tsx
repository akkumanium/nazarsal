"use client";
import dynamic from "next/dynamic";
import { useEffect,useRef,useState } from "react";
import { ArrowRight,ArrowUp,ArrowUpRight,Check,ChevronDown,Clock3,Coffee,Compass,Database,Footprints,Layers,LoaderCircle,LocateFixed,MapPin,Navigation,RefreshCw,Route,Settings2,ShieldCheck,SlidersHorizontal,Sparkles,TreePine,X } from "lucide-react";
import { CATEGORIES,FEATURE_IDS,FEATURE_LABELS } from "@/lib/catalog";
import type { Coverage,DataStatus,Poi,Point,Recommendation } from "@/lib/types";
import type { RecommendRequest,SearchIntent } from "@/lib/intent";
import { CandidateInspector } from "./candidate-inspector";
import { WeatherCard } from "./weather-card";

const CityMap=dynamic(()=>import("./city-map"),{ssr:false,loading:()=> <div className="map-loading"><Compass size={30}/><span>Загрузка карты…</span></div>});
const starters=[
  {icon:TreePine,title:"Прогулка на час",description:"Зелень, виды и немного тишины",text:"Хочу погулять час: зелень, красивые виды и вернуться к началу."},
  {icon:Coffee,title:"Кофе и парк",description:"Любимый ритм свободного дня",text:"Хочу сначала выпить кофе, потом погулять в парке. У меня 90 минут."},
  {icon:Sparkles,title:"Время с ребёнком",description:"Маленькое семейное приключение",text:"Со мной ребёнок. Есть час, хочу найти рядом детскую площадку."}
];
const min=(value:number)=>`${Math.ceil(value)} мин`;
const meters=(value:number)=>value<1000?`${Math.round(value)} м`:`${(value/1000).toFixed(1)} км`;
const time=(value:string)=>new Intl.DateTimeFormat("ru",{hour:"2-digit",minute:"2-digit",timeZone:"Asia/Almaty"}).format(new Date(value));
function CategoryIcon({id,size=18}:{id:string;size?:number}){return id==="coffee"||id==="food"?<Coffee size={size}/>:id==="park"?<TreePine size={size}/>:id==="mall"?<Layers size={size}/>:<Compass size={size}/>;}
function PoiEvidence({poi}:{poi:Poi}){
  const known=FEATURE_IDS.filter(id=>poi.features[id].value!==null);
  return <details className="poi-evidence"><summary><Database size={11}/>Сведения из OSM<ChevronDown size={12}/></summary><div>{known.length?known.map(id=><p key={id}><span>{FEATURE_LABELS[id]}</span><strong>{poi.features[id].value===true?"Да":poi.features[id].value===false?"Нет":poi.features[id].value==="limited"?"Ограниченно":poi.features[id].value==="ask"?"Уточнить у сотрудников":String(poi.features[id].value)}</strong></p>):<p>Дополнительные свойства не указаны.</p>}{poi.openingHours&&<p><span>Расписание</span><strong>{poi.openingHours}</strong></p>}<div className="evidence-links">{(poi.sourceIds??[poi.id]).map(id=><a href={`https://www.openstreetmap.org/${id}`} key={id} target="_blank" rel="noreferrer">{id}<ArrowUpRight size={10}/></a>)}</div></div></details>;
}

type ChatTurn = { id: number; query: string; result?: Recommendation; error?: string };

export function Explorer(){
  const [status,setStatus]=useState<DataStatus|null>(null),[query,setQuery]=useState(""),[origin,setOrigin]=useState<Point|null>(null);
  const [originText,setOriginText]=useState(""),[suggestions,setSuggestions]=useState<Poi[]>([]),[originFocus,setOriginFocus]=useState(false);
  const [duration,setDuration]=useState(60),[returnToStart,setReturnToStart]=useState(false),[maxWalk,setMaxWalk]=useState<number|null>(null);
  const [controls,setControls]=useState<NonNullable<RecommendRequest["controls"]>>({});
  const [result,setResult]=useState<Recommendation|null>(null),[previousIntent,setPreviousIntent]=useState<SearchIntent|null>(null);
  const [selectedPlan,setSelectedPlan]=useState(0),[busy,setBusy]=useState(false),[error,setError]=useState(""),[elapsed,setElapsed]=useState(0);
  const [coverage,setCoverage]=useState<Coverage|null>(null),[coverageOpen,setCoverageOpen]=useState(false),[coverageBusy,setCoverageBusy]=useState(false);
  const [settings,setSettings]=useState(false),[options,setOptions]=useState(false),[locating,setLocating]=useState(false),[excluded,setExcluded]=useState<string[]>([]);
  const [confirmedQuery,setConfirmedQuery]=useState<string|undefined>();
  const [messages,setMessages]=useState<ChatTurn[]>([]);
  const [planSelections,setPlanSelections]=useState<Record<number,number>>({});
  const requestId=useRef(0);
  const textarea=useRef<HTMLTextAreaElement>(null),results=useRef<HTMLDivElement>(null);
  const plan=result?.plans[selectedPlan]??null;
  useEffect(()=>{void fetch("/api/data-status").then(r=>r.json()).then(setStatus).catch(()=>setError("Не удалось проверить подключение к серверу."));},[]);
  useEffect(()=>{
    if(!originFocus||originText.length<2){setSuggestions([]);return;}
    const abort=new AbortController(),timer=setTimeout(()=>{void fetch(`/api/places/search?q=${encodeURIComponent(originText)}`,{signal:abort.signal}).then(r=>r.json()).then(d=>setSuggestions(d.places??[])).catch(()=>{});},280);
    return()=>{clearTimeout(timer);abort.abort();};
  },[originText,originFocus]);
  useEffect(()=>{if(!busy)return;setElapsed(0);const timer=setInterval(()=>setElapsed(v=>v+1),1000);return()=>clearInterval(timer);},[busy]);
  useEffect(()=>{if(settings){const listener=(e:KeyboardEvent)=>{if(e.key==="Escape")setSettings(false);};window.addEventListener("keydown",listener);return()=>window.removeEventListener("keydown",listener);}},[settings]);

  useEffect(()=>{
    const container=results.current?.parentElement;
    if(!container||messages.length===0)return;
    const turns=container.querySelectorAll<HTMLElement>(".chat-turn");
    const latest=turns[turns.length-1];
    container.scrollTo({top:busy?container.scrollHeight:latest?.offsetTop??container.scrollHeight,behavior:"smooth"});
  },[messages,busy]);

  function resetChat(){setMessages([]);setResult(null);setPreviousIntent(null);setExcluded([]);setConfirmedQuery(undefined);setSelectedPlan(0);setPlanSelections({});setQuery("");setError("");textarea.current?.focus();}

  function pickOrigin(point:Point){if(busy)return;setOrigin(point);setOriginText(point.label??"Точка на карте");setSuggestions([]);setOriginFocus(false);setError("");if(result?.status==="needs_clarification"&&result.intent?.originQuery)setConfirmedQuery(result.intent.originQuery);if(result?.status!=="needs_clarification")setResult(null);}
  function locate(){
    if(!navigator.geolocation){setError("Геолокация не поддерживается. Выберите точку на карте.");return;}
    setLocating(true);navigator.geolocation.getCurrentPosition(p=>{pickOrigin({lat:p.coords.latitude,lon:p.coords.longitude,label:"Моё местоположение"});setLocating(false);},()=>{setLocating(false);setError("Не удалось получить геолокацию. Выберите старт на карте или найдите ориентир.");},{enableHighAccuracy:false,timeout:10000,maximumAge:60000});
  }
  async function submit(text=query,extraExcluded=excluded,chosenOrigin=origin,confirm=confirmedQuery){
    if(!text.trim()||busy)return;
    const id=++requestId.current;
    setMessages(items=>[...items,{id,query:text.trim()}]);setQuery("");
    setBusy(true);setError("");setSelectedPlan(0);
    try{
      const response=await fetch("/api/recommend",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({query:text,origin:chosenOrigin,previousIntent,excludedPoiIds:extraExcluded,controls,confirmedOriginQuery:confirm}),signal:AbortSignal.timeout(120000)});
      const data=await response.json();
      if(data.error||(!response.ok&&!data.status)){throw new Error(data.error||"Не удалось получить ответ. Попробуйте ещё раз.");}
      const recommendation=data as Recommendation;setResult(recommendation);
      setMessages(items=>items.map(item=>item.id===id?{...item,result:recommendation}:item));
      if(recommendation.intent){setPreviousIntent(recommendation.intent);setDuration(recommendation.intent.durationMinutes??60);setReturnToStart(recommendation.intent.returnToStart);setMaxWalk(recommendation.intent.maxWalkingMinutes);}
      if(recommendation.origin){setOrigin(recommendation.origin);setOriginText(recommendation.origin.label??"Точка на карте");}
    }catch(cause){const message=cause instanceof Error&&cause.name!=="TimeoutError"&&cause.name!=="TypeError"?cause.message:"Поиск не завершился. Проверьте соединение и повторите запрос.";setMessages(items=>items.map(item=>item.id===id?{...item,error:message}:item));setQuery(draft=>draft||text);}finally{setBusy(false);}
  }
  async function toggleCoverage(){
    const next=!coverageOpen;setCoverageOpen(next);if(!next||coverage)return;
    setCoverageBusy(true);
    try{const response=await fetch("/api/coverage");const data=await response.json();if(!response.ok)throw new Error();setCoverage(data);}
    catch{setError("Покрытие появится после завершения импорта города.");setCoverageOpen(false);}finally{setCoverageBusy(false);}
  }
  function changeDuration(value:number){setDuration(value);setControls(c=>({...c,durationMinutes:value}));}
  return <div className="app-shell">
    <header className="topbar">
      <a href="/" className="brand" aria-label="NazarSal — главная"><span className="brand-symbol"><Footprints size={23}/></span><span>NazarSal<span className="brand-dot">.</span></span></a>
      <nav className="main-nav" aria-label="Основная навигация"><button className={!coverageOpen?"nav-link active":"nav-link"} onClick={()=>setCoverageOpen(false)}>Исследовать город</button><button className={coverageOpen?"nav-link active":"nav-link"} onClick={()=>void toggleCoverage()}>Покрытие города <ArrowUpRight size={13}/></button></nav>
      <div className="topbar-right"><span className="city-badge"><span/>Астана, Казахстан</span><button className="icon-button settings-button" onClick={()=>setSettings(true)} aria-label="Подключения и данные"><Settings2 size={19}/></button></div>
    </header>
    <main>
      <section className="page-intro"><div><div className="intro-eyebrow"><span/>Маленькие открытия большого города</div><h1>Куда пойдём <em>сегодня?</em></h1><p>Кофе, тихий парк или новое любимое место — найдём вашу Астану.</p></div><div className="intro-note"><Compass size={24}/><span>Ближе, чем кажется.<small>Ваш следующий маршрут начинается здесь</small></span></div></section>
      <div className="workspace">
        <section className="sidebar chat-panel" aria-label="Чат с ИИ-помощником">
          <div className="chat-header"><span className="assistant-avatar"><Sparkles size={19}/></span><div><h2>Ваш городской проводник</h2><p>NazarSal · идеи для прогулок</p></div><button className="icon-button" aria-label="Новый диалог" title="Новый диалог" disabled={busy} onClick={resetChat}><RefreshCw size={16}/></button></div>
          <details className="chat-settings"><summary><SlidersHorizontal size={14}/><span>{origin?.label??"Старт и параметры"}</span><small>{min(duration)}</small><ChevronDown size={14}/></summary><fieldset disabled={busy} className="chat-settings-fields">
            <div className="start-section" onBlur={e=>{if(!e.currentTarget.contains(e.relatedTarget as Node))setOriginFocus(false);}}><div className="section-caption"><label htmlFor="origin">Откуда начнём</label><button className="text-button" onClick={locate} disabled={locating}><LocateFixed size={14}/>{locating?"Определяем…":"Я здесь"}</button></div>
              <div className="origin-control"><MapPin size={18}/><input id="origin" aria-label="Начало прогулки" placeholder="Ориентир или точка на карте" value={originText} onChange={e=>{setOriginText(e.target.value);setOriginFocus(true);setOrigin(null);setConfirmedQuery(undefined);}} aria-expanded={originFocus&&suggestions.length>0} aria-autocomplete="list" aria-controls="origin-options" onKeyDown={e=>{if(e.key==="Escape")setOriginFocus(false);if(e.key==="ArrowDown"){e.preventDefault();e.currentTarget.parentElement?.nextElementSibling?.querySelector<HTMLButtonElement>("button")?.focus();}if(e.key==="Enter"&&suggestions.length===1){e.preventDefault();pickOrigin({...suggestions[0].point,label:suggestions[0].name});}}} onFocus={()=>setOriginFocus(true)} />{origin?<span className="origin-check"><Check size={14}/></span>:<ChevronDown size={15}/>}</div>
              {originFocus&&suggestions.length>0&&<div className="origin-suggestions" id="origin-options" role="listbox">{suggestions.map(p=><button role="option" aria-selected={false} key={p.id} onClick={()=>pickOrigin({...p.point,label:p.name})}><MapPin size={15}/><span><strong>{p.name}</strong><small>{p.address||CATEGORIES[p.categories[0]].label}</small></span></button>)}</div>}
            </div>
            <div className="preferences-section"><div className="section-caption"><span>Длительность</span><Clock3 size={14}/></div><div className="duration-options">{[30,60,90,120].map(value=><button key={value} className={duration===value?"selected":""} aria-pressed={duration===value} onClick={()=>changeDuration(value)}>{value===120?"2 часа":`${value} мин`}</button>)}<button className={`adjust-button ${options?"selected":""}`} aria-label="Дополнительные параметры" aria-expanded={options} onClick={()=>setOptions(v=>!v)}><SlidersHorizontal size={15}/></button></div>
              {options&&<div className="advanced-options"><label>Длительность, мин<input type="number" min="10" max="480" value={duration} onChange={e=>{const v=Number(e.target.value);if(v>=10&&v<=480)changeDuration(v);}}/></label><label>Максимум пешком, мин<input type="number" min="0" max="480" placeholder="Без ограничения" value={maxWalk??""} onChange={e=>{const v=e.target.value===""?null:Number(e.target.value);if(v===null||(v>=0&&v<=480)){setMaxWalk(v);setControls(c=>({...c,maxWalkingMinutes:v}));}}}/></label><label className="checkbox-label"><input type="checkbox" checked={returnToStart} onChange={e=>{setReturnToStart(e.target.checked);setControls(c=>({...c,returnToStart:e.target.checked}));}}/>Вернуться к началу</label></div>}
            </div>
          </fieldset></details>
          <div className="sidebar-scroll chat-scroll" role="log" aria-label="История диалога" aria-live="polite" aria-relevant="additions text">
            {messages.length===0&&<div className="assistant-message welcome-message"><span className="welcome-caption">ГОРОД В ВАШЕМ РИТМЕ</span><h3>Хороший день начинается<br/>с маленького плана.</h3><p>Расскажите, чего хочется, и сколько есть времени. Остальное найдём вместе.</p></div>}
            {messages.length===0&&<div className="inspiration"><div className="inspiration-label">Начнём с идеи</div>{starters.map(({icon:Icon,title,description,text})=><button key={title} className="starter-card" onClick={()=>{setQuery(text);textarea.current?.focus();}}><span className="starter-icon"><Icon size={19}/></span><span className="starter-copy"><strong>{title}</strong><small>{description}</small></span><ArrowUpRight size={17}/></button>)}</div>}
            {messages.map(message=>{const result=message.result;const selection=planSelections[message.id]??0;const plan=result?.plans[selection]??null;const latest=message.id===messages[messages.length-1]?.id;return <div className="chat-turn" key={message.id}>
              <div className="user-message"><div>{message.query}</div></div>
              {message.error&&<div className="assistant-message"><div className="message-author"><Sparkles size={13}/>NazarSal</div><p className="error-message">{message.error}</p><button className="text-button" disabled={busy} onClick={()=>void submit(message.query)}>Повторить запрос <RefreshCw size={12}/></button></div>}
              {result&&<div className="results assistant-message"><div className="message-author"><Sparkles size={13}/>NazarSal</div><p className="result-message message-bubble">{result.message}</p>
              {process.env.NODE_ENV!=="production"&&<CandidateInspector result={result}/>}
              {result.originChoices&&<div className="origin-choices">{result.originChoices.map(p=><button className="choice-button" disabled={busy||!latest} key={p.id} onClick={()=>{const next={...p.point,label:p.name};pickOrigin(next);setConfirmedQuery(result.intent?.originQuery??undefined);void submit(message.query,excluded,next,result.intent?.originQuery??undefined);}}><MapPin size={15}/>{p.name}<ArrowRight size={14}/></button>)}</div>}
              {result.plans.length>1&&<div className="plan-tabs">{result.plans.map((p,i)=><button key={p.id} disabled={busy||!latest} onClick={()=>{setPlanSelections(values=>({...values,[message.id]:i}));setResult(result);setSelectedPlan(i);}} className={selection===i?"selected":""}>Вариант {i+1}</button>)}</div>}
              {plan&&<>
                <div className="plan-summary">{result.intent?.mode==="itinerary"&&<span>Прогулка — около {min(plan.totalMinutes)}</span>}<span>{min(plan.walkingMinutes)} пешком{plan.returnToStart?" · с возвращением к старту":""}</span></div>
                <div className="stop-list">{plan.stops.map((stop,i)=><div className="stop-entry" key={stop.poi.id}>
                  <article className="stop-card">
                    <div className="stop-card-top"><span className="stop-number" style={{background:CATEGORIES[stop.poi.categories[0]].color}}>{i+1}</span><div><span className="stop-category">{CATEGORIES[stop.poi.categories[0]].label}</span><h3>{stop.poi.name}</h3></div><a className="source-link" href={stop.poi.sourceUrl} target="_blank" rel="noreferrer" aria-label={`Открыть ${stop.poi.name} в OpenStreetMap`}><ArrowUpRight size={18}/></a></div>
                    {plan.legs[i]&&<div className="stop-walk"><Footprints size={15}/><span>{meters(plan.legs[i].distanceMeters)} · {min(plan.legs[i].durationSeconds/60)} пешком {i===0?"от старта":`от «${plan.stops[i-1].poi.name}»`}</span></div>}
                    {result.intent?.mode==="itinerary"&&<div className="stop-time" aria-label="Примерная длительность посещения"><Clock3 size={16}/><strong>Около {min(stop.visitMinutes)} на месте</strong><span>{time(stop.arrivalAt)}–{time(stop.departureAt)}</span></div>}
                    <p>{stop.why||stop.poi.description} {stop.action||CATEGORIES[stop.poi.categories[0]].action}</p>
                    {stop.poi.address&&<div className="stop-address"><MapPin size={15}/>{stop.poi.address}</div>}
                    <div className="stop-card-footer"><details className="stop-details"><summary>Подробнее<ChevronDown size={15}/></summary><p>{stop.openingState==="unknown"?"Часы работы не указаны":stop.openingState==="closed_by_schedule"?"По расписанию закрыто":"По расписанию открыто"}</p><PoiEvidence poi={stop.poi}/></details><button className="replace-button" disabled={busy||!latest} onClick={()=>{const next=[...excluded,stop.poi.id];setExcluded(next);void submit(`Замени остановку «${stop.poi.name}», сохрани остальные пожелания.`,next);}}><RefreshCw size={14}/>Заменить</button></div>
                  </article>
                  {i<plan.stops.length-1&&plan.legs[i+1]&&<div className="between-stops"><Footprints size={16}/><span>{min(plan.legs[i+1].durationSeconds/60)} пешком до «{plan.stops[i+1].poi.name}»</span></div>}
                </div>)}</div>
              </>}
              {result.places.length>0&&!plan&&result.places.map(p=><article className="stop-card" key={p.id}><div className="stop-card-top"><span className="place-category-icon" style={{color:CATEGORIES[p.categories[0]].color}}><CategoryIcon id={p.categories[0]}/></span><div><span className="stop-category">{CATEGORIES[p.categories[0]].label}</span><h3>{p.name}</h3></div><a className="source-link" href={p.sourceUrl} target="_blank" rel="noreferrer" aria-label={`Открыть ${p.name} в OpenStreetMap`}><ArrowUpRight size={16}/></a></div>{p.description&&<p>{p.description}</p>}{p.address&&<div className="stop-address"><MapPin size={12}/>{p.address}</div>}<details className="stop-details"><summary>Подробнее<ChevronDown size={15}/></summary><PoiEvidence poi={p}/></details></article>)}
            </div>}
            </div>;})}
            {busy&&<div className="assistant-message thinking-message" role="status"><div className="message-author"><Sparkles size={13}/>NazarSal</div><div className="message-bubble"><LoaderCircle size={15} className="spin"/><span>Подбираю места и маршрут…</span><small>{elapsed} с</small></div></div>}
            <div ref={results} className="chat-end"/>
          </div>
            <div className="wish-section chat-input">
              <div className="composer"><textarea id="wish" ref={textarea} aria-label="Сообщение помощнику" rows={2} maxLength={2000} placeholder="Например, кофе и прогулка у реки…" value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();void submit();}}}/><div className="composer-bottom"><span className="composer-hint">Ваши пожелания → ваш маршрут</span><button className="send-button" aria-label="Отправить сообщение" disabled={busy||!query.trim()} onClick={()=>void submit()}>{busy?<LoaderCircle size={18} className="spin"/>:<ArrowUp size={20}/>}</button></div></div>
              {error&&<p className="error-message" role="alert">{error}</p>}
            </div>

        </section>
        <section className="map-panel" aria-label="Карта и маршрут"><CityMap routingProvider={status?.routingProvider} origin={origin} plan={plan} places={result?.places??[]} coverage={coverageOpen?coverage:null} onPick={pickOrigin}/>
          <div className="map-topline"><div className="map-top-stack"><WeatherCard/>{coverageOpen&&<div className="map-label"><span className="map-label-icon"><Navigation size={16}/></span><span><strong>Покрытие Астаны</strong><small>Количество мест · сетка 1 км</small></span></div>}</div><button className={`map-layer-button ${coverageOpen?"active":""}`} onClick={()=>void toggleCoverage()} aria-label="Показать покрытие города" aria-pressed={coverageOpen}>{coverageBusy?<LoaderCircle className="spin" size={18}/>:<Layers size={18}/>}</button></div>
          {!origin&&!coverageOpen&&<div className="map-invitation"><MapPin size={18}/><span>Нажмите на карту, чтобы выбрать старт</span></div>}
          {plan&&<div className="map-route-info"><span className="route-info-icon"><Route size={20}/></span><div><strong>{result?.intent?.mode==="itinerary"?<>{plan.stops.length} {plan.stops.length===1?"остановка":"остановки"} · {min(plan.totalMinutes)}</>:<>{min(plan.walkingMinutes)} пешком</>}</strong><small>{Math.round(plan.legs.reduce((s,l)=>s+l.distanceMeters,0))/1000} км пешком{plan.returnToStart?" · круговой маршрут":""}</small></div><span className="route-verified"><Check size={13}/>Путь рассчитан</span></div>}
          {coverageOpen&&<div className="coverage-legend"><strong>Плотность мест</strong><div><span className="legend-scale"/><span>Меньше → больше</span></div><small>{coverage?.features.length??0} участков · 1 км² каждый</small></div>}
        </section>
      </div>
    </main>
    {settings&&<div className="modal-backdrop" onClick={()=>setSettings(false)}><section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" onClick={e=>e.stopPropagation()}><button className="modal-close icon-button" onClick={()=>setSettings(false)} aria-label="Закрыть"><X size={20}/></button><h2 id="settings-title">Данные и подключения</h2><p>Все рекомендации опираются на опубликованную базу OSM. Состояние ключей означает наличие настройки, а не проверку доступа к API.</p><div className="connection-list">{[["PostgreSQL / PostGIS",!!status?.schemaReady],["OpenAI · GPT-6 Luna",!!status?.openai],["Пешеходные маршруты",!!status?.routing],["Датасет Астаны",!!status?.dataset]].map(([name,ready])=><div key={String(name)}><span>{String(name)}</span><span className={ready?"connection-ready":"connection-missing"}>{ready?<><Check size={13}/>Настроено</>:"Нужно подключить"}</span></div>)}</div>{status?.message&&<p className="setup-message">{status.message}</p>}<div className="setup-instructions"><strong>Первый запуск</strong><p>Заполните серверный <code>.env.local</code> по примеру <code>.env.example</code>. Для Supabase укажите DATABASE_URL; для локальной разработки — LOCAL_DATABASE_PATH.</p><pre>pnpm db:migrate{"\n"}pnpm data:collect{"\n"}pnpm data:audit</pre></div>{status?.latestImport&&<p className="import-progress">Последняя загрузка: {status.latestImport.completedTiles}/{status.latestImport.totalTiles} квадратов · {status.latestImport.status}</p>}<div className="privacy-note"><ShieldCheck size={17}/><span>Геолокация используется по вашему действию. История перемещений не сохраняется. Координаты получает сервис маршрутов; OpenAI получает пожелания и сведения о найденных местах.</span></div><a className="osm-credit" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">Данные © OpenStreetMap contributors · ODbL <ArrowUpRight size={13}/></a></section></div>}
  </div>;
}

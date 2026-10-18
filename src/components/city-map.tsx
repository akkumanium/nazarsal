"use client";
import { useEffect,useRef,useState,useMemo } from "react";
import L from "leaflet";
import { useLanguage } from "./language-provider";
import "leaflet/dist/leaflet.css";
import { CATEGORIES } from "@/lib/catalog";
import type { Coverage,Plan,Poi,Point } from "@/lib/types";
import { MapComments } from "./map-comments";

export default function CityMap({origin,plan,places,coverage,onPick,routingProvider}:{origin:Point|null;plan:Plan|null;places:Poi[];coverage:Coverage|null;onPick:(p:Point)=>void;routingProvider?:"ors"|"geoapify"}){
  const {t}=useLanguage();
  const [mapInstance,setMapInstance]=useState<L.Map|null>(null);
  const knownPlaces=useMemo(()=>(plan?.stops.map(stop=>stop.poi)??places).map(poi=>({id:poi.id,name:poi.name,point:poi.point})),[plan,places]);
  const translator=useRef(t);translator.current=t;
  const container=useRef<HTMLDivElement>(null),map=useRef<L.Map|null>(null),layer=useRef<L.LayerGroup|null>(null);
  const picker=useRef(onPick);picker.current=onPick;
  useEffect(()=>{
    if(!container.current||map.current)return;
    const m=L.map(container.current,{zoomControl:false,attributionControl:true}).setView([51.1282,71.4304],12);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a>'}).addTo(m);

    m.on("click",(event:L.LeafletMouseEvent)=>{if(m.getContainer().dataset.commentSelecting!=="true")picker.current({lat:event.latlng.lat,lon:event.latlng.lng,label:translator.current("Точка на карте")});});
    m.on("keypress",(event:L.LeafletKeyboardEvent)=>{if(event.originalEvent.key==="Enter"&&m.getContainer().dataset.commentSelecting!=="true"){const center=m.getCenter();picker.current({lat:center.lat,lon:center.lng,label:translator.current("Точка на карте")});}});
    map.current=m;layer.current=L.layerGroup().addTo(m);
    setMapInstance(m);
    const observer=new ResizeObserver(()=>m.invalidateSize());observer.observe(container.current);
    return()=>{observer.disconnect();m.remove();map.current=null;layer.current=null;};
  },[]);
  useEffect(()=>{
    const m=map.current;if(!m)return;
    const zoom=L.control.zoom({position:"bottomright",zoomInTitle:t("Приблизить"),zoomOutTitle:t("Отдалить")}).addTo(m);
    const attribution=`${t("Погода")}: <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">Open-Meteo</a>`;
    m.attributionControl.addAttribution(attribution);
    return()=>{zoom.remove();m.attributionControl.removeAttribution(attribution);};
  },[t]);
  useEffect(()=>{
    const attribution='Powered by <a href="https://www.geoapify.com/" target="_blank">Geoapify</a>';
    if(routingProvider!=="geoapify")return;
    map.current?.attributionControl.addAttribution(attribution);
    return()=>{map.current?.attributionControl.removeAttribution(attribution);};
  },[routingProvider]);
  useEffect(()=>{
    const m=map.current,g=layer.current;if(!m||!g)return;
    g.clearLayers();
    if(coverage){
      L.geoJSON(coverage,{style:f=>({color:f?.properties.count?"#276d60":"#b2a79a",weight:1,fillColor:f?.properties.count?"#3e8c78":"#cbbba7",fillOpacity:f?.properties.count?Math.min(.48,.10+Math.log1p(f.properties.count)/12):.12}),onEachFeature:(feature,polygon)=>{
        const p=feature.properties,content=document.createElement("div");
        content.className="coverage-popup";
        const title=document.createElement("strong");title.textContent=`${p.count} ${t("мест · квадрат 1 км")}`;content.append(title);
        const detail=document.createElement("p");detail.textContent=p.count?Object.entries(p.categories).map(([id,count])=>`${t(CATEGORIES[id as keyof typeof CATEGORIES]?.label??id)}: ${count}`).join(" · "):p.state==="empty_verified"?t("Подходящие POI в OSM не найдены; полнота загрузки проверена."):t("Нужна проверка загрузки.");content.append(detail);
        const landuseLabels:Record<string,string>={residential:"жилая застройка",commercial:"деловая застройка",retail:"торговая территория",industrial:"промышленная территория",recreation_ground:"зона отдыха"};
        const use=document.createElement("p");use.textContent=`${t("Территория:")} ${p.landuse.map((kind:string)=>t(landuseLabels[kind]??kind)).join(", ")||t("нет данных о землепользовании")}`;content.append(use);
        polygon.bindPopup(content);
      }}).addTo(g);
    }
    if(origin)L.marker([origin.lat,origin.lon],{icon:L.divIcon({className:"origin-pin",html:'<span></span>',iconSize:[24,24],iconAnchor:[12,12]})}).addTo(g).bindTooltip(t("Старт"),{direction:"top",offset:[0,-12]});
    const stops=plan?.stops.map(s=>s.poi)??places;
    stops.forEach((poi,index)=>{
      const color=CATEGORIES[poi.categories[0]].color;
      const marker=L.marker([poi.point.lat,poi.point.lon],{icon:L.divIcon({className:"poi-pin",html:`<span style="background:${color}"><b>${index+1}</b></span>`,iconSize:[34,42],iconAnchor:[17,40]})}).addTo(g);
      const title=document.createElement("span");title.textContent=poi.name;marker.bindTooltip(title,{direction:"top",offset:[0,-35]});
    });
    if(plan?.geometry)L.geoJSON(plan.geometry,{style:{color:plan.travelMode==="drive"?"#3d6aab":"#197264",weight:5,opacity:.9,lineCap:"round",dashArray:plan.verified?undefined:"5 8"}}).addTo(g);
    if(plan?.stops.length){const bounds=L.latLngBounds([...(origin?[[origin.lat,origin.lon] as L.LatLngTuple]:[]),...plan.stops.map(s=>[s.poi.point.lat,s.poi.point.lon] as L.LatLngTuple)]);m.fitBounds(bounds,{padding:[65,65],maxZoom:16});}
    else if(origin)m.flyTo([origin.lat,origin.lon],Math.max(m.getZoom(),14),{duration:.6});
    else if(coverage?.features.length){const extent=L.geoJSON(coverage).getBounds();if(extent.isValid())m.fitBounds(extent,{padding:[30,30]});}
  },[origin,plan,places,coverage,t]);
  return <><div ref={container} className="map-canvas" role="application" aria-label={t("Карта Астаны. Нажмите на карту, чтобы выбрать начало прогулки.")}/>{mapInstance&&<MapComments map={mapInstance} knownPlaces={knownPlaces}/>}</>;
}

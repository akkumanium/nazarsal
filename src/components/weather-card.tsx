"use client";

import { useEffect, useState } from "react";
import { Cloud, CloudFog, CloudLightning, CloudMoon, CloudRain, CloudSnow, CloudSun, LoaderCircle, Moon, RefreshCw, Sun, Wind } from "lucide-react";
import { formatTemperature, weatherCondition, type CurrentWeather, type WeatherIcon } from "@/lib/weather";

import { useLanguage } from "./language-provider";

const icons = { sun: Sun, moon: Moon, "cloud-sun": CloudSun, "cloud-moon": CloudMoon, cloud: Cloud, fog: CloudFog, rain: CloudRain, snow: CloudSnow, storm: CloudLightning } satisfies Record<WeatherIcon, typeof Sun>;
const localTime = (value: string) => new Intl.DateTimeFormat("ru", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Almaty" }).format(new Date(value));

export function WeatherCard() {
  const {t}=useLanguage();
  const [weather, setWeather] = useState<CurrentWeather | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch("/api/weather", { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]), cache: "no-store" });
        if (!response.ok) throw new Error("Weather unavailable");
        const data: CurrentWeather = await response.json();
        if (!controller.signal.aborted) { setWeather(data); setFailed(false); }
      } catch {
        if (!controller.signal.aborted) { setWeather(null); setFailed(true); }
      }
    }
    void load();
    const timer = window.setInterval(() => void load(), 15 * 60 * 1000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [attempt]);

  const condition = weather ? weatherCondition(weather.code, weather.isDay) : null;
  const Icon = condition ? icons[condition.icon] : Cloud;

  return <aside className={`weather-card${weather && !weather.isDay ? " weather-card-night" : ""}`} aria-label={t("Погода в Астане")}>
    <div className="weather-card-heading"><span className="weather-live-dot"/>{t("Астана")}{weather && <time className="weather-time" dateTime={weather.observedAt} title={t("Время погодных данных в Астане")}>{localTime(weather.observedAt)}</time>}</div>
    <div aria-live="polite" aria-atomic="true">
      {weather && condition ? <>
        <div className="weather-card-main">
          <span className="weather-symbol"><Icon size={32} strokeWidth={1.7} aria-hidden="true"/></span>
          <div><strong className="weather-temperature" aria-label={`${formatTemperature(weather.temperature)} ${t("Цельсия")}`}>{formatTemperature(weather.temperature)}<span>C</span></strong><p className="weather-condition">{t(condition.label)}</p></div>
        </div>
        <div className="weather-details"><span>{t("Ощущается как")} {formatTemperature(weather.feelsLike)}</span><span><Wind size={12} aria-hidden="true"/>{Math.round(weather.windSpeed)} {t("м/с")}</span></div>
      </> : <div className="weather-placeholder">
        {failed ? <><Cloud size={26} strokeWidth={1.5} aria-hidden="true"/><span>{t("Погода недоступна")}</span><button type="button" onClick={() => { setFailed(false); setAttempt(value => value + 1); }} aria-label={t("Обновить погоду")}><RefreshCw size={15}/></button></>
          : <><LoaderCircle size={23} className="spin" aria-hidden="true"/><span>{t("Загружаем погоду…")}</span></>}
      </div>}
    </div>
  </aside>;
}

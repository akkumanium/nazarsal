export type CurrentWeather = {
  temperature: number;
  feelsLike: number;
  windSpeed: number;
  code: number;
  isDay: boolean;
  observedAt: string;
};

export type WeatherIcon = "sun" | "moon" | "cloud-sun" | "cloud-moon" | "cloud" | "fog" | "rain" | "snow" | "storm";

// WMO weather codes used by Open-Meteo. Unknown codes remain neutral.
export function weatherCondition(code: number, isDay: boolean): { label: string; icon: WeatherIcon } {
  if (code === 0) return { label: "Ясно", icon: isDay ? "sun" : "moon" };
  if (code === 1 || code === 2) return { label: "Переменная облачность", icon: isDay ? "cloud-sun" : "cloud-moon" };
  if (code === 3) return { label: "Пасмурно", icon: "cloud" };
  if (code === 45 || code === 48) return { label: "Туман", icon: "fog" };
  if ([51, 53, 55].includes(code)) return { label: "Морось", icon: "rain" };
  if ([56, 57, 66, 67].includes(code)) return { label: "Ледяные осадки", icon: "rain" };
  if ([61, 63, 65, 80, 81, 82].includes(code)) return { label: "Дождь", icon: "rain" };
  if ([71, 73, 75, 77, 85, 86].includes(code)) return { label: "Снег", icon: "snow" };
  if ([95, 96, 99].includes(code)) return { label: "Гроза", icon: "storm" };
  return { label: "Погода", icon: "cloud" };
}

export function formatTemperature(value: number): string {
  const rounded = Math.round(value);
  return `${rounded > 0 ? "+" : ""}${rounded === 0 ? 0 : rounded}°`;
}

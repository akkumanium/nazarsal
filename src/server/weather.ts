import { z } from "zod";
import type { CurrentWeather } from "@/lib/weather";

const responseSchema = z.object({
  current: z.object({
    time: z.number().finite(),
    temperature_2m: z.number().finite(),
    apparent_temperature: z.number().finite(),
    wind_speed_10m: z.number().nonnegative(),
    weather_code: z.number().int().nonnegative(),
    is_day: z.union([z.literal(0), z.literal(1)])
  })
});

export async function getCurrentWeather(): Promise<CurrentWeather> {
  // A shared city forecast avoids transmitting or storing the user's GPS position.
  const params = new URLSearchParams({
    latitude: "51.1282", longitude: "71.4304",
    current: "temperature_2m,apparent_temperature,weather_code,wind_speed_10m,is_day",
    temperature_unit: "celsius", wind_speed_unit: "ms", timeformat: "unixtime"
  });
  const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, {
    next: { revalidate: 900 }, signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error("Weather service unavailable");
  const { current } = responseSchema.parse(await response.json());
  const observedAt = new Date(current.time * 1000).toISOString();
  if (Math.abs(Date.now() - current.time * 1000) > 90 * 60 * 1000) throw new Error("Weather data is stale");
  return {
    temperature: current.temperature_2m, feelsLike: current.apparent_temperature,
    windSpeed: current.wind_speed_10m, code: current.weather_code,
    isDay: current.is_day === 1, observedAt
  };
}

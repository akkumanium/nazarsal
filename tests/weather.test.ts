import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "../src/app/api/weather/route";
import { formatTemperature, weatherCondition } from "../src/lib/weather";

const payload = () => ({ current: {
  time: Math.floor(Date.now() / 1000), temperature_2m: -2.4, apparent_temperature: -6.1,
  wind_speed_10m: 5.3, weather_code: 71, is_day: 0
} });
afterEach(() => { vi.unstubAllGlobals(); });

describe("map weather", () => {
  it("returns validated current conditions for Astana, with explicit units and a 15 minute cache", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(payload()));
    vi.stubGlobal("fetch", fetcher);
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ temperature: -2.4, feelsLike: -6.1, windSpeed: 5.3, code: 71, isDay: false });
    const [requestUrl, options] = fetcher.mock.calls[0];
    const url = new URL(requestUrl);
    expect(url.origin).toBe("https://api.open-meteo.com");
    expect(url.searchParams.get("latitude")).toBe("51.1282");
    expect(url.searchParams.get("longitude")).toBe("71.4304");
    expect(url.searchParams.get("temperature_unit")).toBe("celsius");
    expect(url.searchParams.get("wind_speed_unit")).toBe("ms");
    expect(options.next.revalidate).toBe(900);
  });
  it("returns an unavailable state for provider failures without exposing upstream errors", async () => {
    for (const result of [new Response("private upstream error", { status: 429 }), new Response("not JSON"), Response.json({ current: null })]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(result));
      const response = await GET();
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "Погода временно недоступна" });
    }
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("timeout", "TimeoutError")));
    expect((await GET()).status).toBe(503);
  });
  it("does not present null temperatures, invalid day flags or stale conditions as current weather", async () => {
    for (const patch of [{ temperature_2m: null }, { is_day: 2 }, { time: Math.floor(Date.now() / 1000) - 7200 }]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ current: { ...payload().current, ...patch } })));
      expect((await GET()).status).toBe(503);
    }
  });
  it("uses night icons and neutral labels for unknown weather codes", () => {
    expect(weatherCondition(0, false)).toEqual({ icon: "moon", label: "Ясно" });
    expect(weatherCondition(2, false).icon).toBe("cloud-moon");
    expect(weatherCondition(71, true).icon).toBe("snow");
    expect(weatherCondition(95, true).icon).toBe("storm");
    expect(weatherCondition(123, true)).toEqual({ icon: "cloud", label: "Погода" });
    expect(formatTemperature(-0.2)).toBe("0°");
    expect(formatTemperature(8.9)).toBe("+9°");
    expect(formatTemperature(-6.1)).toBe("-6°");
  });
});

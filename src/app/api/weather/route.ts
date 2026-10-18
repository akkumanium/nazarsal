import { getCurrentWeather } from "@/server/weather";
import { json } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return json(await getCurrentWeather());
  } catch {
    return json({ error: "Погода временно недоступна" }, 503);
  }
}

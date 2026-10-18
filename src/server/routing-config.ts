import { ConfigurationError } from "./db";

export type RoutingProvider = "ors" | "geoapify";

export function routingProvider(): RoutingProvider {
  const provider = process.env.ROUTING_PROVIDER?.trim() || "ors";
  if (provider !== "ors" && provider !== "geoapify") {
    throw new ConfigurationError("ROUTING_PROVIDER должен быть ors или geoapify.");
  }
  return provider;
}

export function routingConfig() {
  const provider = routingProvider();
  const keyName = provider === "geoapify" ? "GEOAPIFY_API_KEY" : "ORS_API_KEY";
  const apiKey = process.env[keyName]?.trim();
  if (!apiKey) throw new ConfigurationError(`Подключите маршрутизацию: заполните ${keyName}.`);
  return { provider, apiKey, keyName, name: provider === "geoapify" ? "Geoapify" : "openrouteservice" };
}

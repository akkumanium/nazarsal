export function normalizeText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("ru").replace(/ё/g, "е")
    .replace(/[ә]/g, "а").replace(/[ө]/g, "о").replace(/[ұү]/g, "у").replace(/қ/g, "к")
    .replace(/ғ/g, "г").replace(/і/g, "и").replace(/ң/g, "н").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}
export function safeWebsite(value: string | undefined): string | null {
  if (!value) return null;
  try { const u = new URL(value.startsWith("http") ? value : `https://${value}`); return ["https:", "http:"].includes(u.protocol) && !u.username && !u.password ? u.href : null; } catch { return null; }
}
export function redactCoordinates(text: string): string {
  return text.replace(/(?<!\d)[+-]?\d{1,2}\.\d{3,}\s*[,; ]\s*[+-]?\d{1,3}\.\d{3,}(?!\d)/g, "[координаты обрабатываются сервером]");
}

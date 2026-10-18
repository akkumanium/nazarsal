import { describe, expect, it } from "vitest";
import { isLanguage, translate } from "../src/lib/i18n";
import { requestSchema } from "../src/lib/intent";

describe("language selection", () => {
  it("validates travel modes and carries them across follow-up requests", () => {
    expect(requestSchema.parse({query:"Coffee",travelMode:"drive"}).travelMode).toBe("drive");
    expect(requestSchema.parse({query:"Coffee",travelMode:"walk"}).travelMode).toBe("walk");
    expect(requestSchema.safeParse({query:"Coffee",travelMode:"fly"}).success).toBe(false);
    expect(requestSchema.parse({query:"Coffee"}).travelMode).toBeUndefined();
  });
  it.each(["kk", "ru", "en"])("accepts %s in recommendation requests", language => {
    expect(requestSchema.parse({ query: "Coffee", language }).language).toBe(language);
    expect(isLanguage(language)).toBe(true);
  });
  it("rejects unsupported language values and preserves older requests", () => {
    expect(requestSchema.safeParse({ query: "Coffee", language: "fr" }).success).toBe(false);
    expect(isLanguage("fr")).toBe(false);
    expect(isLanguage(null)).toBe(false);
    expect(requestSchema.parse({ query: "Coffee" }).language).toBeUndefined();
  });
  it("translates interface copy and preserves data such as place names", () => {
    expect(translate("kk", "Исследовать город")).toBe("Қаланы аралау");
    expect(translate("en", "Исследовать город")).toBe("Explore the city");
    expect(translate("ru", "Исследовать город")).toBe("Исследовать город");
    expect(translate("en", "Открыть {name} в OpenStreetMap", { name: "Бәйтерек" })).toBe("Open Бәйтерек in OpenStreetMap");
    expect(translate("kk", "Бәйтерек")).toBe("Бәйтерек");
  });
});

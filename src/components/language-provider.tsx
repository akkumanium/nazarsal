"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { isLanguage, translate, type Language } from "@/lib/i18n";

const STORAGE_KEY = "nazarsal-language";
const LanguageContext = createContext({
  language: "ru" as Language,
  setLanguage: (_language: Language) => {},
  t: (text: string, values?: Record<string, string | number>) => translate("ru", text, values),
});

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [language, updateLanguage] = useState<Language>("ru");
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (isLanguage(saved)) updateLanguage(saved);
    } catch { /* Storage may be disabled; switching still works for this visit. */ }
  }, []);
  useEffect(() => { document.documentElement.lang = language; }, [language]);
  const setLanguage = useCallback((value: Language) => {
    updateLanguage(value);
    try { localStorage.setItem(STORAGE_KEY, value); } catch { /* Keep the in-memory choice. */ }
  }, []);
  const t = useCallback((text: string, values?: Record<string, string | number>) => translate(language, text, values), [language]);
  return <LanguageContext.Provider value={{ language, setLanguage, t }}>{children}</LanguageContext.Provider>;
}

export function useLanguage() { return useContext(LanguageContext); }

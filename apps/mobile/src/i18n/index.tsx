import AsyncStorage from "@react-native-async-storage/async-storage";
import { getLocales } from "expo-localization";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppState, Platform } from "react-native";

export type Language = "zh-CN" | "en";
export type LanguagePreference = "system" | Language;
const STORAGE_KEY = "piko.language";

export function resolveLanguage(tag: string | null | undefined): Language {
  return tag?.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

function deviceLanguage(): Language {
  return resolveLanguage(getLocales()[0]?.languageTag);
}

function isPreference(value: string | null): value is LanguagePreference {
  return value === "system" || value === "zh-CN" || value === "en";
}

type LanguageContextValue = {
  language: Language;
  preference: LanguagePreference;
  setPreference: (value: LanguagePreference) => void;
};

const LanguageContext = createContext<LanguageContextValue | null>(null);

/** Device-local UI preference; it does not affect server prompts or user content. */
export function LanguageProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<LanguagePreference>("system");
  const [systemLanguage, setSystemLanguage] = useState(deviceLanguage);
  const edited = useRef(false);
  const writes = useRef(Promise.resolve());

  useEffect(() => {
    let active = true;
    void AsyncStorage.getItem(STORAGE_KEY).then((value) => {
      if (active && !edited.current && isPreference(value)) setPreferenceState(value);
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const refresh = () => setSystemLanguage(deviceLanguage());
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") refresh();
    });
    if (Platform.OS === "web" && typeof window !== "undefined") window.addEventListener("languagechange", refresh);
    return () => {
      subscription.remove();
      if (Platform.OS === "web" && typeof window !== "undefined") window.removeEventListener("languagechange", refresh);
    };
  }, []);

  const setPreference = useCallback((value: LanguagePreference) => {
    edited.current = true;
    setPreferenceState(value);
    writes.current = writes.current.then(() => AsyncStorage.setItem(STORAGE_KEY, value)).catch(() => undefined);
  }, []);
  const language = preference === "system" ? systemLanguage : preference;
  const context = useMemo(() => ({ language, preference, setPreference }), [language, preference, setPreference]);
  return <LanguageContext.Provider value={context}>{children}</LanguageContext.Provider>;
}

export function useLanguage(): LanguageContextValue {
  const value = useContext(LanguageContext);
  if (!value) throw new Error("useLanguage requires LanguageProvider");
  return value;
}

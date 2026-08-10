/**
 * i18n setup using react-i18next (P1-6 / §8).
 *
 * Supports English and Arabic. The language is controlled by
 * settings.general.language and persisted across sessions.
 */

import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import en from "./en.json";
import ar from "./ar.json";

const resources = {
  en: { translation: en },
  ar: { translation: ar },
};

i18n
  .use(initReactI18next)
  .init({
    resources,
    lng: "en", // default; will be overridden by useTheme based on settings
    fallbackLng: "en",
    interpolation: {
      escapeValue: false, // React already escapes
    },
    react: {
      useSuspense: false, // we handle loading ourselves
    },
  });

export default i18n;
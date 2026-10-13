/**
 * i18n initialization module
 *
 * - On first visit read navigator.language (starts with zh → Chinese, otherwise → English)
 * - After a manual switch by the user, persist to localStorage
 * - useTranslation of react-i18next automatically triggers component re-rendering
 */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { zhCN } from './zh-CN';
import { enUS } from './en-US';

const STORAGE_KEY = 'tdai-memory.lang';

function detectInitialLanguage(): string {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === 'zh-CN' || stored === 'en-US') return stored;
  const nav = navigator.language || 'zh-CN';
  return nav.startsWith('zh') ? 'zh-CN' : 'en-US';
}

export function changeLanguage(lang: string): void {
  i18n.changeLanguage(lang);
  localStorage.setItem(STORAGE_KEY, lang);
}

export function getCurrentLanguage(): string {
  return i18n.language || 'zh-CN';
}

i18n.use(initReactI18next).init({
  resources: {
    'zh-CN': { translation: zhCN },
    'en-US': { translation: enUS },
  },
  lng: detectInitialLanguage(),
  fallbackLng: 'zh-CN',
  interpolation: {
    escapeValue: false,
  },
  react: {
    useSuspense: false,
  },
});

export default i18n;

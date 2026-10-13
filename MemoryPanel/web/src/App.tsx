/**
 * App.tsx — Root component
 *
 * Responsibilities:
 *   1. Manage login state (zustand auth store, backed by the new panel Control's sessionStorage session)
 *   2. On startup, check whether the cached local session is valid (checkSession):
 *        - Checking → loading
 *        - Not logged in → LoginGate
 *        - Logged in
 *   3. Initialize event sync for the team store
 *   4. Sync the react-i18next language → tea-component ConfigProvider,
 *      so built-in tea-component texts (StatusTip loading, Table no data, etc.)
 *      follow the user's language switch automatically.
 */
import { useEffect, useState } from 'react';
import { RouterProvider } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ConfigProvider } from 'tea-component';
import LoginGate from '@/components/LoginGate';
import { useAuthStore } from '@/stores/auth';
import { router } from '@/routes';

/** react-i18next language → tea-component locale mapping */
function toTeaLocale(lang: string): 'zh' | 'en' {
  return lang.startsWith('zh') ? 'zh' : 'en';
}

export default function App() {
  const { t, i18n } = useTranslation();
  const auth = useAuthStore((s) => s.auth);
  const setAuth = useAuthStore((s) => s.setAuth);
  const checkSession = useAuthStore((s) => s.checkSession);
  // Current tea-component locale, kept in sync with react-i18next
  const [teaLocale, setTeaLocale] = useState<'zh' | 'en'>(() => toTeaLocale(i18n.language));

  // Listen for react-i18next language changes and sync them to tea-component tea-component
  useEffect(() => {
    setTeaLocale(toTeaLocale(i18n.language));
    const handler = (lng: string) => setTeaLocale(toTeaLocale(lng));
    i18n.on('languageChanged', handler);
    return () => i18n.off('languageChanged', handler);
  }, [i18n]);

  // On startup, check whether the sessionStorage-cached { instance_id, user_key, user } is valid
  useEffect(() => {
    checkSession();
  }, [checkSession]);

  const content = (() => {
    if (auth === null) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-[#0f172a]">
          <div className="text-sm text-slate-500 dark:text-slate-400">{t('app.checkingSession')}</div>
        </div>
      );
    }

    if (auth === undefined) {
      return <LoginGate onLoggedIn={(a) => setAuth(a)} />;
    }

    return <RouterProvider router={router} />;
  })();

  return (
    <ConfigProvider locale={teaLocale}>
      {content}
    </ConfigProvider>
  );
}

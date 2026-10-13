/**
 * GuidePage -- usage guide page (route /guide)
 *
 * Two main blocks:
 *   1. Quick start: Proxy address (reads the current instance) -> Default/Analyse mode -> API Key,
 *      Skill / script as the two integration methods, plus a "Manual configuration" section giving the config file and content per IDE;
 *   2. Best practices: step-by-step guidance for two scenarios, team Coding / personal OPC.
 * At the bottom there is an "Onboarding replay" entry: consistent with "My profile -> Revisit onboarding", to re-watch the first-use onboarding.
 *
 * The config file paths and contents of manual configuration are kept consistent with the write_* functions of agents/setup-proxy.sh
 * (this page is read-only display and performs no writes). API Keys always use placeholders, never real keys.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/stores/auth';
import { resetOnboarding } from '@/layouts/OnboardingGuide';
import { metaInstancesApi } from '@/lib/teamApi';
import { getPanelSession } from '@/lib/panelSession';
import { tea } from '@/lib/tea-bridge';
import { CopyButton } from './CopyButton';
import { MemCommands } from './MemCommands';
import './style.css';

type MainTab = 'quick' | 'practice' | 'commands';
type QuickTab = 'download' | 'ide' | 'history';
type PracticeId = 'team' | 'personal';
type ManualIdeId = 'claude' | 'codebuddy' | 'codex' | 'workbuddy' | 'dsh' | 'hermes' | 'openclaw';
type ProxyMode = 'default' | 'analyse';

interface PracticeStep {
  /** i18n key (guide.practice.team.stepN.title etc.) */
  title: string;
  short: string;
  points: string[];
  /** label is an i18n key (reuses menu.* keys) */
  links: Array<{ label: string; path: string }>;
}

/** Quick start three-step flow (titles/descriptions are all i18n keys) */
const QUICK_STEPS: Array<{ id: QuickTab; title: string; sub: string }> = [
  { id: 'download', title: 'guide.step.download.title', sub: 'guide.step.download.sub' },
  { id: 'ide', title: 'guide.step.ide.title', sub: 'guide.step.ide.sub' },
  { id: 'history', title: 'guide.step.history.title', sub: 'guide.step.history.sub' },
];

const QUICK_SETUP_SCRIPT = 'bash agents/setup-proxy.sh';
const QUICK_SETUP_SKILL_PREP = 'cp -r agents ~/agents';
const QUICK_SETUP_SKILL_PROMPT =
  'Please read ~/agents/skills/setup-proxy/SKILL.md, then follow the steps in it to guide me through configuring my Agent to connect to the Memory Proxy.';
const HISTORY_IMPORT_SCRIPT = 'tsx agents/asset-import.ts --source <agent> --agent-id <id> --team-id <tid>';
const HISTORY_SOURCES = 'claude-code, codebuddy, codex, workbuddy, dsh, hermes, openclaw';
const KEY_PLACEHOLDER = '<your-team-memory-api-key>';

/** Access address: {base}/{agent}/{instanceId}(/analyse), consistent with the Proxy whitelist shape.
 * Note that Claude Code's proxy route segment is `claude-code` (see MemoryProxy whitelist.ts's
 * AGENT_PREFIX_RE and setup-proxy.sh), while this page's IDE identifier is `claude`, so it must be normalized. */
function proxyEndpoint(base: string, agent: ManualIdeId, instanceId: string, mode: ProxyMode) {
  const pathAgent = agent === 'claude' ? 'claude-code' : agent;
  return `${base}/${pathAgent}/${instanceId}${mode === 'analyse' ? '/analyse' : ''}`;
}

interface ManualIde {
  id: ManualIdeId;
  name: string;
  file: string;
  protocol: string;
  /** Generate config file content (placeholders, no real keys). The second argument is the access address. */
  config: (base: string, instanceId: string, mode: ProxyMode, model: string) => string;
  /** Startup / notes (optional) */
  notes?: string[];
}

const MANUAL_IDES: ManualIde[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    file: '~/.claude/settings.json',
    protocol: 'Anthropic Messages',
    config: (base, instanceId, mode, model) =>
      `{\n  "env": {\n    "ANTHROPIC_BASE_URL": "${proxyEndpoint(base, 'claude', instanceId, mode)}",\n    "ANTHROPIC_AUTH_TOKEN": "${KEY_PLACEHOLDER}",\n    "ANTHROPIC_MODEL": "${model}",\n    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "${model}",\n    "ANTHROPIC_DEFAULT_SONNET_MODEL": "${model}",\n    "ANTHROPIC_DEFAULT_OPUS_MODEL": "${model}",\n    "CLAUDE_CODE_SUBAGENT_MODEL": "${model}"\n  }\n}`,
    notes: ['guide.manual.note.claude'],
  },
  {
    id: 'codebuddy',
    name: 'CodeBuddy',
    file: '~/.codebuddy/models.json',
    protocol: 'OpenAI Chat',
    config: (base, instanceId, mode, model) =>
      `{\n  "models": [\n    {\n      "id": "${model}",\n      "name": "proxy-memory-agent",\n      "vendor": "claude",\n      "apiKey": "${KEY_PLACEHOLDER}",\n      "maxInputTokens": 200000,\n      "url": "${proxyEndpoint(base, 'codebuddy', instanceId, mode)}",\n      "supportsToolCall": true,\n      "supportsImages": true\n    }\n  ]\n}`,
    notes: ['guide.manual.note.codebuddy'],
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    file: '~/.codex/config.toml',
    protocol: 'OpenAI Responses',
    config: (base, instanceId, mode, model) =>
      `model_provider = "team-proxy"\nmodel = "${model}"\nmodel_reasoning_effort = "high"\ndisable_response_storage = true\n\n[model_providers.team-proxy]\nname       = "TDAI team-proxy"\nwire_api   = "responses"\nbase_url   = "${proxyEndpoint(base, 'codex', instanceId, mode)}"\nexperimental_bearer_token = "${KEY_PLACEHOLDER}"\n\nrequest_max_retries    = 2\nstream_max_retries     = 3\nstream_idle_timeout_ms = 120000`,
    notes: ['guide.manual.note.codex'],
  },
  {
    id: 'workbuddy',
    name: 'WorkBuddy',
    file: '~/.workbuddy/models.json',
    protocol: 'OpenAI Responses/Chat',
    config: (base, instanceId, mode, model) =>
      `[\n  {\n    "id": "${model}",\n    "name": "${model}",\n    "vendor": "Custom",\n    "url": "${proxyEndpoint(base, 'workbuddy', instanceId, mode)}",\n    "apiKey": "${KEY_PLACEHOLDER}",\n    "supportsToolCall": true,\n    "supportsImages": false,\n    "supportsReasoning": false,\n    "useCustomProtocol": false\n  }\n]`,
    notes: ['guide.manual.note.workbuddy'],
  },
  {
    id: 'dsh',
    name: 'dsh (DeepSeek Harness)',
    file: '~/.dsh/settings.yaml + ~/.dsh/.credentials.yaml',
    protocol: 'OpenAI Chat',
    config: (base, instanceId, mode, model) =>
      `# ~/.dsh/settings.yaml\nllm-deepseek:\n  apiKeyEnv: PROXY_USER_KEY\n  # Do not append /v1 -- dsh hardcodes baseURL/chat/completions\n  baseURL: ${proxyEndpoint(base, 'dsh', instanceId, mode)}\n  model: ${model}\n  reasoningEffort: high\n\n# ~/.dsh/.credentials.yaml\nPROXY_USER_KEY: ${KEY_PLACEHOLDER}`,
    notes: [
      'guide.manual.note.dsh.0',
      'guide.manual.note.dsh.1',
      'guide.manual.note.dsh.2',
    ],
  },
  {
    id: 'hermes',
    name: 'Hermes',
    file: '~/.hermes/config.yaml',
    protocol: 'OpenAI Chat + Header preselect',
    config: (base, instanceId, mode, model) =>
      `model:\n  default: ${model}\n  provider: custom\n  base_url: ${proxyEndpoint(base, 'hermes', instanceId, mode)}\n  api_key: ${KEY_PLACEHOLDER}\n  extra_headers:\n    x-team-id: "<team-id>"\n    x-agent-id: "<agent-id>"\n    x-task-id: "no-task"\n    x-conversation-id: "<conv-id>"`,
    notes: [
      'guide.manual.note.hermes.0',
      'guide.manual.note.hermes.1',
      'guide.manual.note.hermes.2',
    ],
  },
  {
    id: 'openclaw',
    name: 'OpenClaw',
    file: '~/.openclaw/openclaw.json',
    protocol: 'OpenAI Chat + Header preselect',
    config: (base, instanceId, mode, model) =>
      `{\n  "models": {\n    "mode": "merge",\n    "providers": {\n      "memory-proxy": {\n        "baseUrl": "${proxyEndpoint(base, 'openclaw', instanceId, mode)}",\n        "apiKey": "${KEY_PLACEHOLDER}",\n        "api": "openai-completions",\n        "headers": {\n          "x-team-id": "<team-id>",\n          "x-agent-id": "<agent-id>",\n          "x-task-id": "no-task",\n          "x-conversation-id": "<conv-id>"\n        },\n        "request": { "allowPrivateNetwork": true },\n        "models": [\n          {\n            "id": "${model}",\n            "name": "${model}",\n            "reasoning": false,\n            "input": ["text"],\n            "contextWindow": 128000,\n            "maxTokens": 32000,\n            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }\n          }\n        ]\n      }\n    }\n  }\n}`,
    notes: [
      'guide.manual.note.openclaw.0',
      'guide.manual.note.openclaw.1',
      'guide.manual.note.openclaw.2',
    ],
  },
];

const PRACTICE_STEPS: Record<PracticeId, PracticeStep[]> = {
  team: [
    {
      title: 'guide.practice.team.step1.title',
      short: 'guide.practice.team.step1.short',
      points: [
        'guide.practice.team.step1.point1',
        'guide.practice.team.step1.point2',
        'guide.practice.team.step1.point3',
      ],
      links: [
        { label: 'menu.team_members', path: '/team/members' },
        { label: 'menu.api_keys', path: '/team/api-keys' },
      ],
    },
    {
      title: 'guide.practice.team.step2.title',
      short: 'guide.practice.team.step2.short',
      points: [
        'guide.practice.team.step2.point1',
        'guide.practice.team.step2.point2',
        'guide.practice.team.step2.point3',
      ],
      links: [
        { label: 'menu.chat_memory', path: '/memory' },
        { label: 'menu.skills', path: '/skills' },
      ],
    },
    {
      title: 'guide.practice.team.step3.title',
      short: 'guide.practice.team.step3.short',
      points: [
        'guide.practice.team.step3.point1',
        'guide.practice.team.step3.point2',
        'guide.practice.team.step3.point3',
      ],
      links: [
        { label: 'menu.chat_memory', path: '/memory' },
        { label: 'menu.skills', path: '/skills' },
        { label: 'menu.wiki', path: '/wiki' },
      ],
    },
    {
      title: 'guide.practice.team.step4.title',
      short: 'guide.practice.team.step4.short',
      points: [
        'guide.practice.team.step4.point1',
        'guide.practice.team.step4.point2',
        'guide.practice.team.step4.point3',
      ],
      links: [
        { label: 'menu.team_agents', path: '/team/agents' },
        { label: 'menu.chat_memory', path: '/memory' },
      ],
    },
  ],
  personal: [
    {
      title: 'guide.practice.personal.step1.title',
      short: 'guide.practice.personal.step1.short',
      points: [
        'guide.practice.personal.step1.point1',
        'guide.practice.personal.step1.point2',
        'guide.practice.personal.step1.point3',
      ],
      links: [
        { label: 'menu.api_keys', path: '/team/api-keys' },
        { label: 'menu.chat_memory', path: '/memory' },
      ],
    },
    {
      title: 'guide.practice.personal.step2.title',
      short: 'guide.practice.personal.step2.short',
      points: [
        'guide.practice.personal.step2.point1',
        'guide.practice.personal.step2.point2',
        'guide.practice.personal.step2.point3',
      ],
      links: [
        { label: 'menu.team_agents', path: '/team/agents' },
        { label: 'menu.skills', path: '/skills' },
      ],
    },
    {
      title: 'guide.practice.personal.step3.title',
      short: 'guide.practice.personal.step3.short',
      points: [
        'guide.practice.personal.step3.point1',
        'guide.practice.personal.step3.point2',
        'guide.practice.personal.step3.point3',
      ],
      links: [
        { label: 'menu.chat_memory', path: '/memory' },
        { label: 'menu.skills', path: '/skills' },
      ],
    },
    {
      title: 'guide.practice.personal.step4.title',
      short: 'guide.practice.personal.step4.short',
      points: [
        'guide.practice.personal.step4.point1',
        'guide.practice.personal.step4.point2',
        'guide.practice.personal.step4.point3',
      ],
      links: [
        { label: 'menu.chat_memory', path: '/memory' },
        { label: 'menu.skills', path: '/skills' },
        { label: 'menu.wiki', path: '/wiki' },
      ],
    },
  ],
};

export function GuidePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const auth = useAuthStore((s) => s.auth);

  const [mainTab, setMainTab] = useState<MainTab>('quick');
  // Quick start three steps: download config package -> connect IDE -> import history data.
  // Defaults to step 1, the step bar guides users down step by step.
  const [quickTab, setQuickTab] = useState<QuickTab>('download');
  // Steps already passed (for the step bar's "completed" state, letting users know their progress)
  const [visitedSteps, setVisitedSteps] = useState<QuickTab[]>(['download']);
  const [practice, setPractice] = useState<PracticeId>('team');
  const [practiceStep, setPracticeStep] = useState(0);
  const [method, setMethod] = useState<'skill' | 'script'>('skill');
  const [proxyMode, setProxyMode] = useState<ProxyMode>('default');
  const [proxyBase, setProxyBase] = useState('');
  const [instanceId, setInstanceId] = useState('default');
  const [urlHint, setUrlHint] = useState(t('guide.proxyHint.reading'));
  const [manualOpen, setManualOpen] = useState(false);
  const [manualIdeId, setManualIdeId] = useState<ManualIdeId>('claude');
  const [modelId, setModelId] = useState('claude-sonnet-4-5');

  useEffect(() => {
    const session = getPanelSession();
    const fallback = `${window.location.protocol}//${window.location.hostname}:8096`;
    metaInstancesApi
      .list()
      .then((instances) => {
        const current =
          instances.find((item) => item.instance_id === session?.instanceId) ??
          instances.find((item) => item.instance_id === 'default') ??
          instances[0];
        if (current) {
          setInstanceId(current.instance_id);
          setProxyBase((current.proxy_endpoint || fallback).replace(/\/$/, ''));
          setUrlHint(
            current.proxy_endpoint
              ? t('guide.proxyHint.fromInstance', { name: current.name })
              : t('guide.proxyHint.defaultHost'),
          );
        } else {
          setProxyBase(fallback);
          setUrlHint(t('guide.proxyHint.noInstance'));
        }
      })
      .catch(() => {
        setProxyBase(fallback);
        setUrlHint(t('guide.proxyHint.readFailed'));
      });
  }, [t]);

  /** Onboarding replay: exactly the same as "My profile -> Revisit onboarding" -- clear the flag + have ConsoleLayout pop it up again */
  const handleReplayOnboarding = () => {
    if (auth?.user_id) {
      resetOnboarding(auth.user_id);
      // After ConsoleLayout listens to this event, setOnboardingVisible(true)
      window.dispatchEvent(new CustomEvent('tdai-replay-onboarding'));
      tea.notify.success(t('guide.replayStarted'));
    }
  };

  const manualIde = MANUAL_IDES.find((item) => item.id === manualIdeId) ?? MANUAL_IDES[0];
  const proxyFallback = t('guide.proxyFallback');
  const modelFallback = t('guide.modelFallback');
  const manualConfig = useMemo(
    () => manualIde.config(proxyBase || proxyFallback, instanceId, proxyMode, modelId || modelFallback),
    [manualIde, modelId, proxyBase, proxyMode, instanceId, proxyFallback, modelFallback],
  );
  const practiceSteps = PRACTICE_STEPS[practice];
  const activePracticeStep = practiceSteps[practiceStep] ?? practiceSteps[0];

  return (
    <div className="guide-page">
      <header className="guide-titlebar">
        <div>
          <button type="button" className="guide-back" onClick={() => navigate(-1)}>
            ← {t('guide.back')}
          </button>
          <h1>{t('guide.title')}</h1>
          <p>{t('guide.subtitle')}</p>
        </div>
        <span className="guide-brand">{t('guide.brand')}</span>
      </header>

      <nav className="guide-main-tabs" aria-label={t('guide.tabs.aria')}>
        <button
          type="button"
          className={mainTab === 'quick' ? 'active' : ''}
          onClick={() => setMainTab('quick')}
        >
          <b>{t('guide.quick.title')}</b>
          <small>{t('guide.quick.sub')}</small>
        </button>
        <button
          type="button"
          className={mainTab === 'practice' ? 'active' : ''}
          onClick={() => setMainTab('practice')}
        >
          <b>{t('guide.practice.title')}</b>
          <small>{t('guide.practice.sub')}</small>
        </button>
        <button
          type="button"
          className={mainTab === 'commands' ? 'active' : ''}
          onClick={() => setMainTab('commands')}
        >
          <b>{t('guide.mem.title')}</b>
          <small>{t('guide.mem.sub')}</small>
        </button>
      </nav>

      {mainTab === 'quick' ? (
        <section className="guide-surface">
          {/* Three-step flow step bar: download config package -> connect IDE -> import history data */}
          <ol className="guide-stepper" aria-label={t('guide.quick.tabs.aria')}>
            {QUICK_STEPS.map((step, index) => {
              const isDone = visitedSteps.includes(step.id);
              const isCurrent = quickTab === step.id;
              return (
                <li key={step.id} className={isCurrent ? 'current' : isDone ? 'done' : ''}>
                  <button
                    type="button"
                    aria-current={isCurrent ? 'step' : undefined}
                    onClick={() => {
                      setQuickTab(step.id);
                      setVisitedSteps((prev) => (prev.includes(step.id) ? prev : [...prev, step.id]));
                    }}
                  >
                    <span className="guide-stepper-badge">{isDone ? '✓' : index + 1}</span>
                    <span className="guide-stepper-meta">
                      <b>{t(step.title)}</b>
                      <small>{t(step.sub)}</small>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>

          {/* Step 1: download config package */}
          {quickTab === 'download' && (
            <div className="guide-package-download">
              <div>
                <b>{t('guide.download.title')}</b>
                <small>{t('guide.download.desc')}</small>
              </div>
              {/* Use a root-relative path rather than an absolute path: under HashRouter an absolute path is parsed as a route,
                  jumping to /downloads/... instead of triggering a file download.
                  Add a ?v= version param to force the browser to bypass the cache and download the latest ZIP, avoiding downloading a stale pre-fix package */}
              <a href="./downloads/tdai-memory-agents.zip?v=2" download>
                {t('guide.download.button')}
              </a>
            </div>
          )}

          {/* Step 2: connect IDE */}
          {quickTab === 'ide' && (
            <>
              <div className="guide-prepare">
                <div className="guide-prepare-row">
                  <b>{t('guide.prepare.proxy')}</b>
                  <code className="guide-prepare-value">{proxyBase || t('guide.prepare.reading')}</code>
                  <CopyButton value={proxyBase} />
                </div>
                <small className="guide-prepare-hint">{urlHint}</small>

                <div className="guide-mode-item">
                  <b>{t('guide.prepare.mode')}</b>
                  <div className="guide-mode-options">
                    <button
                      type="button"
                      className={proxyMode === 'default' ? 'active' : ''}
                      onClick={() => setProxyMode('default')}
                    >
                      {t('guide.mode.default')}
                    </button>
                    <button
                      type="button"
                      className={proxyMode === 'analyse' ? 'active' : ''}
                      onClick={() => {
                        setProxyMode('analyse');
                        // Analyse requires manually configuring the access address (the script/Skill only writes the Default address),
                        // so the manual config area is auto-expanded when selected, to avoid users "not knowing where to configure after choosing".
                        setManualOpen(true);
                      }}
                    >
                      {t('guide.mode.analyse')}
                    </button>
                  </div>
                  <small>{t('guide.mode.analyseHint')}</small>
                  {proxyMode === 'analyse' && (
                    <small className="guide-mode-notice">
                      {t('guide.mode.analyseNotice')}
                    </small>
                  )}
                </div>

                <div className="guide-prepare-row">
                  <b>{t('guide.prepare.key')}</b>
                  <button type="button" className="guide-key-link" onClick={() => navigate('/team/api-keys')}>
                    {t('guide.prepare.keyLink')} →
                  </button>
                </div>
              </div>

              <div className="guide-method-picker" role="radiogroup" aria-label={t('guide.method.aria')}>
                <button
                  type="button"
                  className={method === 'skill' ? 'active' : ''}
                  onClick={() => setMethod('skill')}
                >
                  <b>{t('guide.method.skill.title')}</b>
                  <small>{t('guide.method.skill.sub')}</small>
                </button>
                <button
                  type="button"
                  className={method === 'script' ? 'active' : ''}
                  onClick={() => setMethod('script')}
                >
                  <b>{t('guide.method.script.title')}</b>
                  <small>{t('guide.method.script.sub')}</small>
                </button>
              </div>

              {method === 'skill' ? (
                <div className="guide-setup-steps">
                  <p>
                    <b>1</b>
                    {t('guide.method.skill.step1')}
                  </p>
                  <div className="guide-command primary">
                    <code>{QUICK_SETUP_SKILL_PREP}</code>
                    <CopyButton value={QUICK_SETUP_SKILL_PREP} label={t('guide.copyCmd')} />
                  </div>
                  <p>
                    <b>2</b>
                    {t('guide.method.skill.step2')}
                  </p>
                  <div className="guide-command primary">
                    <code>{QUICK_SETUP_SKILL_PROMPT}</code>
                    <CopyButton value={QUICK_SETUP_SKILL_PROMPT} label={t('guide.copyPrompt')} />
                  </div>
                  <p className="guide-run-hint">{t('guide.method.skill.hint')}</p>
                </div>
              ) : (
                <div className="guide-setup-steps">
                  <p>
                    <b>1</b>
                    {t('guide.method.script.step1')}
                  </p>
                  <div className="guide-command primary">
                    <code>{QUICK_SETUP_SCRIPT}</code>
                    <CopyButton value={QUICK_SETUP_SCRIPT} label={t('guide.copyCmd')} />
                  </div>
                  <p className="guide-run-hint">{t('guide.method.script.hint')}</p>
                </div>
              )}

              <div className="guide-manual-entry">
                <button
                  type="button"
                  onClick={() => setManualOpen((open) => !open)}
                  aria-expanded={manualOpen}
                >
                  {manualOpen ? t('guide.manual.collapse') : t('guide.manual.expand')}
                </button>
              </div>

              {manualOpen && (
                <div className="guide-manual-panel">
                  <h3>{t('guide.manual.title')}</h3>
                  <div className="guide-ide-list">
                    {MANUAL_IDES.map((item) => (
                      <button
                        type="button"
                        key={item.id}
                        className={manualIdeId === item.id ? 'active' : ''}
                        onClick={() => setManualIdeId(item.id)}
                      >
                        <span>
                          <b>{item.name}</b>
                          <small>{item.file}</small>
                        </span>
                      </button>
                    ))}
                  </div>
                  <div className="guide-manual-fields">
                    <label>
                      <b>{t('guide.manual.model')}</b>
                      <input
                        value={modelId}
                        onChange={(event) => setModelId(event.target.value.toLowerCase())}
                      />
                      <small>{t('guide.manual.modelHint')}</small>
                    </label>
                    <div className="guide-command secondary">
                      <code>{proxyEndpoint(proxyBase || proxyFallback, manualIde.id, instanceId, proxyMode)}</code>
                      <CopyButton
                        value={proxyEndpoint(proxyBase || proxyFallback, manualIde.id, instanceId, proxyMode)}
                      />
                    </div>
                  </div>
                  <div className="guide-code-card">
                    <header>
                      <div>
                        <h3>{manualIde.name}</h3>
                        <p>
                          {t('guide.manual.fileHint')} <code>{manualIde.file}</code>
                        </p>
                      </div>
                      <CopyButton value={manualConfig} label={t('guide.copyConfig')} />
                    </header>
                    <pre>{manualConfig}</pre>
                  </div>
                  {manualIde.notes && manualIde.notes.length > 0 && (
                    <ul className="guide-manual-notes">
                      {manualIde.notes.map((note) => (
                        <li key={note}>{t(note)}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </>
          )}

          {/* Step 3: import history data */}
          {quickTab === 'history' && (
            <div className="guide-history">
              <h3>{t('guide.quick.history.title')}</h3>
              <p>{t('guide.quick.history.desc')}</p>
              <div className="guide-command primary">
                <code>{HISTORY_IMPORT_SCRIPT}</code>
                <CopyButton value={HISTORY_IMPORT_SCRIPT} label={t('guide.copyScript')} />
              </div>
              <p className="guide-run-hint">
                {t('guide.quick.history.sources', { sources: HISTORY_SOURCES })}
                {t('guide.quick.history.dupHint')}
              </p>

              {/* Config verification: go back to the IDE and start a new conversation; seeing "Linked team assets" means the connection succeeded */}
              <div className="guide-verify">
                <div className="guide-verify-title">
                  <span className="guide-verify-badge">✓</span>
                  {t('guide.verify.title')}
                </div>
                <p className="guide-verify-desc">{t('guide.verify.desc')}</p>
              </div>
            </div>
          )}

          {/* Step navigation: previous / next, explicitly guiding users to complete the three steps in order */}
          <nav className="guide-step-nav" aria-label={t('guide.step.navAria')}>
            {quickTab !== 'download' && (
              <button
                type="button"
                onClick={() => {
                  const order: QuickTab[] = ['download', 'ide', 'history'];
                  const idx = order.indexOf(quickTab);
                  const prev = order[Math.max(0, idx - 1)];
                  setQuickTab(prev);
                  setVisitedSteps((seen) => (seen.includes(prev) ? seen : [...seen, prev]));
                }}
              >
                ← {t('guide.step.prev')}
              </button>
            )}
            {quickTab !== 'history' && (
              <button
                type="button"
                className="guide-step-next"
                onClick={() => {
                  const order: QuickTab[] = ['download', 'ide', 'history'];
                  const idx = order.indexOf(quickTab);
                  const next = order[Math.min(order.length - 1, idx + 1)];
                  setQuickTab(next);
                  setVisitedSteps((seen) => (seen.includes(next) ? seen : [...seen, next]));
                }}
              >
                {t('guide.step.next')} →
              </button>
            )}
            {quickTab === 'history' && (
              <span className="guide-step-done">{t('guide.step.done')}</span>
            )}
          </nav>
        </section>
      ) : mainTab === 'practice' ? (
        <section className="guide-surface guide-practice">
          <div className="guide-practice-tabs">
            <button
              type="button"
              className={practice === 'team' ? 'active' : ''}
              onClick={() => {
                setPractice('team');
                setPracticeStep(0);
              }}
            >
              <b>{t('guide.practice.team.title')}</b>
              <small>{t('guide.practice.team.sub')}</small>
            </button>
            <button
              type="button"
              className={practice === 'personal' ? 'active' : ''}
              onClick={() => {
                setPractice('personal');
                setPracticeStep(0);
              }}
            >
              <b>{t('guide.practice.personal.title')}</b>
              <small>{t('guide.practice.personal.sub')}</small>
            </button>
          </div>

          <div className="guide-practice-visual">
            <div className={`guide-practice-diagram ${practice}`}>
              {practice === 'team' ? (
                <>
                  <div>
                    <strong>{t('guide.diagram.multiIde')}</strong>
                    <span>{t('guide.diagram.sessionSkill')}</span>
                  </div>
                  <i>→</i>
                  <div>
                    <strong>{t('guide.diagram.members')}</strong>
                    <span>{t('guide.diagram.userAgent')}</span>
                  </div>
                  <i>→</i>
                  <div className="focus">
                    <strong>{t('guide.diagram.assets')}</strong>
                    <span>{t('guide.diagram.assetSet')}</span>
                  </div>
                  <i>→</i>
                  <div>
                    <strong>{t('guide.diagram.reuse')}</strong>
                    <span>{t('guide.diagram.reuseSub')}</span>
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <strong>{t('guide.diagram.multiIde')}</strong>
                    <span>{t('guide.diagram.uniAccess')}</span>
                  </div>
                  <i>→</i>
                  <div>
                    <strong>{t('guide.diagram.agents')}</strong>
                    <span>{t('guide.diagram.agentsSub')}</span>
                  </div>
                  <i>→</i>
                  <div className="focus">
                    <strong>{t('guide.diagram.assets')}</strong>
                    <span>{t('guide.diagram.memorySkill')}</span>
                  </div>
                  <i>→</i>
                  <div>
                    <strong>{t('guide.diagram.relay')}</strong>
                    <span>{t('guide.diagram.relaySub')}</span>
                  </div>
                </>
              )}
            </div>

            <div className="guide-practice-step-tabs">
              {practiceSteps.map((step, index) => (
                <button
                  type="button"
                  key={step.title}
                  className={practiceStep === index ? 'active' : ''}
                  onClick={() => setPracticeStep(index)}
                >
                  <span>{index + 1}</span>
                  <b>{t(step.title)}</b>
                  <small>{t(step.short)}</small>
                </button>
              ))}
            </div>

            <div className="guide-practice-detail">
              <div>
                <small>STEP {practiceStep + 1}</small>
                <h2>{t(activePracticeStep.title)}</h2>
                <p>{t(activePracticeStep.short)}</p>
              </div>
              <ul>
                {activePracticeStep.points.map((point) => (
                  <li key={point}>{t(point)}</li>
                ))}
              </ul>
              <nav className="guide-practice-links" aria-label={`${t(activePracticeStep.title)} ${t('guide.practice.linksAria')}`}>
                <span>{t('guide.practice.related')}</span>
                {activePracticeStep.links.map((link) => (
                  <button type="button" key={link.path} onClick={() => navigate(link.path)}>
                    {t(link.label)} →
                  </button>
                ))}
              </nav>
            </div>

            <div className="guide-practice-rules">
              {practice === 'team' ? (
                <>
                  <p>
                    <b>{t('guide.rules.multi')}</b>
                    {t('guide.rules.multiTeamDesc')}
                  </p>
                  <p>
                    <b>{t('guide.rules.share')}</b>
                    {t('guide.rules.shareDesc')}
                  </p>
                  <p>
                    <b>{t('guide.rules.govern')}</b>
                    {t('guide.rules.governDesc')}
                  </p>
                </>
              ) : (
                <>
                  <p>
                    <b>{t('guide.rules.multi')}</b>
                    {t('guide.rules.multiPersonalDesc')}
                  </p>
                  <p>
                    <b>{t('guide.rules.agents')}</b>
                    {t('guide.rules.agentsDesc')}
                  </p>
                  <p>
                    <b>{t('guide.rules.reuse')}</b>
                    {t('guide.rules.reuseDesc')}
                  </p>
                </>
              )}
            </div>
          </div>
        </section>
      ) : (
        <MemCommands />
      )}

      {/* Bottom: frontend onboarding replay */}
      <section className="guide-replay">
        <div>
          <h3>{t('guide.replay.title')}</h3>
          <p>{t('guide.replay.desc')}</p>
        </div>
        <button type="button" className="guide-replay-btn" onClick={handleReplayOnboarding}>
          {t('guide.replay.button')}
        </button>
      </section>
    </div>
  );
}

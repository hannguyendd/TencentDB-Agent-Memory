/**
 * MemCommands -- content component of the GuidePage "Memory commands" main tab.
 *
 * Shows all `mem:` commands supported in Agent sessions:
 *   - Top note: command format conventions;
 *   - Lists each command as a card by group (daily high-frequency / task management); the raw command can be copied in one click,
 *     and commands that need multi-step confirmation (create-task / update-task) additionally show a "reply options" table;
 *   - A "Command examples" section at the bottom, where a set of common commands can be copied as a whole.
 *
 * Pure display component; data comes from memCommands.ts, and the copy interaction reuses CopyButton.
 */
import { useTranslation } from 'react-i18next';
import { CopyButton } from './CopyButton';
import { MEM_COMMANDS, MEM_EXAMPLES_KEY, MEM_GROUPS, type MemCommand } from './memCommandsData';

function CommandCard({ cmd }: { cmd: MemCommand }) {
  const { t } = useTranslation();
  // The display text contains placeholders (changes with language); the copied value takes only the static part of the command, to avoid copying placeholders
  const displayCommand = cmd.argKey ? `${cmd.command} ${t(cmd.argKey)}` : cmd.command;
  return (
    <li className="guide-mem-card">
      <div className="guide-command primary">
        <code>{displayCommand}</code>
        <CopyButton value={cmd.command} label={t('guide.copyCmd')} />
      </div>
      <p className="guide-mem-desc">{t(cmd.descKey)}</p>

      {cmd.detailKeys && cmd.detailKeys.length > 0 && (
        <ul className="guide-mem-details">
          {cmd.detailKeys.map((key) => (
            <li key={key}>{t(key)}</li>
          ))}
        </ul>
      )}

      {cmd.options && cmd.options.length > 0 && (
        <div className="guide-mem-options">
          <span className="guide-mem-options-title">{t('guide.mem.optionsTitle')}</span>
          {cmd.options.map((opt) => (
            <div
              key={opt.reply}
              className={`guide-mem-option${opt.recommended ? ' recommended' : ''}`}
            >
              <div className="guide-command secondary">
                <code>{opt.reply}</code>
                <CopyButton value={opt.reply} />
              </div>
              <span className="guide-mem-option-effect">
                {opt.recommended && <em className="guide-mem-tag">{t('guide.mem.recommended')}</em>}
                {t(opt.effect)}
              </span>
            </div>
          ))}
        </div>
      )}
    </li>
  );
}

export function MemCommands() {
  const { t } = useTranslation();
  const examples = t(MEM_EXAMPLES_KEY);

  return (
    <section className="guide-surface guide-mem">
      <div className="guide-mem-intro">
        <h3>{t('guide.mem.intro.title')}</h3>
        <p>{t('guide.mem.intro.desc')}</p>
        <p className="guide-mem-format">{t('guide.mem.intro.format')}</p>
      </div>

      {MEM_GROUPS.map((group) => {
        const commands = MEM_COMMANDS.filter((cmd) => cmd.group === group.id);
        if (commands.length === 0) return null;
        return (
          <div className="guide-mem-group" key={group.id}>
            <div className="guide-mem-group-head">
              <b>{t(group.titleKey)}</b>
              <small>{t(group.subKey)}</small>
            </div>
            <ul className="guide-mem-list">
              {commands.map((cmd) => (
                <CommandCard cmd={cmd} key={cmd.id} />
              ))}
            </ul>
          </div>
        );
      })}

      <div className="guide-mem-examples">
        <header>
          <div>
            <b>{t('guide.mem.examples.title')}</b>
            <small>{t('guide.mem.examples.sub')}</small>
          </div>
          <CopyButton value={examples} label={t('guide.mem.examples.copyAll')} />
        </header>
        <pre>{examples}</pre>
      </div>
    </section>
  );
}

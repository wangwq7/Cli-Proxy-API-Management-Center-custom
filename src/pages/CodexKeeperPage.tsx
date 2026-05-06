import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import styles from './CodexKeeperPage.module.scss';

const KEEPER_CONSOLE_PATH = '/keeper-api/console';

export function CodexKeeperPage() {
  const { t } = useTranslation();
  const [frameKey, setFrameKey] = useState(0);
  const consoleUrl = useMemo(() => `${KEEPER_CONSOLE_PATH}?embed=management-center&v=${frameKey}`, [frameKey]);

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.pageTitle}>{t('codex_keeper.title', { defaultValue: 'Codex Keeper' })}</h1>
          <p className={styles.subtitle}>
            {t('codex_keeper.subtitle', {
              defaultValue: '嵌入原版 CPACodexKeeper 控制台，保留小方块、巡检、策略参数、筛选分页和已删除凭证管理。'
            })}
          </p>
        </div>
        <div className={styles.headerActions}>
          <Button variant="secondary" size="sm" onClick={() => setFrameKey((value) => value + 1)}>
            {t('common.refresh', { defaultValue: '刷新' })}
          </Button>
          <a className="btn btn-secondary btn-sm" href={KEEPER_CONSOLE_PATH} target="_blank" rel="noreferrer">
            {t('codex_keeper.open_new_window', { defaultValue: '新窗口打开' })}
          </a>
        </div>
      </div>

      <div className={styles.frameShell}>
        <iframe
          key={frameKey}
          title="CPACodexKeeper Console"
          src={consoleUrl}
          className={styles.keeperFrame}
          referrerPolicy="same-origin"
        />
      </div>
    </div>
  );
}

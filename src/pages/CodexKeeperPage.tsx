import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useInterval } from '@/hooks/useInterval';
import { keeperApi, type KeeperJob, type KeeperMonitorStatus, type KeeperToken } from '@/services/api/keeper';
import styles from './CodexKeeperPage.module.scss';

type LoadMode = 'cache' | 'live';

const formatDateTime = (seconds?: number | null) => {
  if (!seconds) return '-';
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString();
};

const formatMsDateTime = (ms?: number | null) => {
  if (!ms) return '-';
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString();
};

const formatPercent = (value: unknown) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return '-';
  return `${Math.max(0, Math.min(100, parsed)).toFixed(0)}%`;
};

const usageUsedPercent = (token: KeeperToken) => {
  const usage = token.usage || {};
  const primary = Number(usage.primary_used_percent);
  const secondary = Number(usage.secondary_used_percent);
  if (Number.isFinite(primary) && Number.isFinite(secondary)) return Math.max(primary, secondary);
  if (Number.isFinite(primary)) return primary;
  if (Number.isFinite(secondary)) return secondary;
  return null;
};

const getTokenStatus = (token: KeeperToken) => {
  if (token.disabled) return { label: 'Disabled', className: styles.statusNeutral };
  const status = String(token.keeper_status || '').toLowerCase();
  if (status.includes('expired') || status.includes('dead')) {
    return { label: 'Expired', className: styles.statusDanger };
  }
  const used = usageUsedPercent(token);
  if (used !== null && used >= 100) return { label: 'No quota', className: styles.statusDanger };
  if (used !== null && used >= 90) return { label: 'Warn', className: styles.statusWarn };
  if (token.last_check_error) return { label: 'Check failed', className: styles.statusWarn };
  return { label: 'Healthy', className: styles.statusGood };
};

const summarizeTokens = (tokens: KeeperToken[]) => {
  let enabled = 0;
  let disabled = 0;
  let noQuota = 0;
  let warning = 0;
  let error = 0;
  tokens.forEach((token) => {
    if (token.disabled) disabled += 1;
    else enabled += 1;
    const used = usageUsedPercent(token);
    if (used !== null && used >= 100) noQuota += 1;
    else if (used !== null && used >= 90) warning += 1;
    if (token.last_check_error) error += 1;
  });
  return { total: tokens.length, enabled, disabled, noQuota, warning, error };
};

export function CodexKeeperPage() {
  const { t } = useTranslation();
  const [tokens, setTokens] = useState<KeeperToken[]>([]);
  const [deletedTokens, setDeletedTokens] = useState<KeeperToken[]>([]);
  const [job, setJob] = useState<KeeperJob | null>(null);
  const [monitorStatus, setMonitorStatus] = useState<KeeperMonitorStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState('');
  const [error, setError] = useState('');
  const [unauthorized, setUnauthorized] = useState(false);
  const [password, setPassword] = useState(() => keeperApi.getPassword());
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const [search, setSearch] = useState('');

  const loadJob = useCallback(async () => {
    const data = await keeperApi.getJob(220);
    setJob(data);
  }, []);

  const loadMonitorStatus = useCallback(async () => {
    const data = await keeperApi.getMonitorStatus();
    setMonitorStatus(data);
  }, []);

  const loadAll = useCallback(async (mode: LoadMode = 'cache') => {
    setLoading(true);
    setError('');
    try {
      const [tokenRes, deletedRes, jobRes, statusRes] = await Promise.all([
        keeperApi.listTokens(mode === 'live'),
        keeperApi.listDeletedTokens(),
        keeperApi.getJob(220),
        keeperApi.getMonitorStatus(),
      ]);
      setTokens(tokenRes.tokens || []);
      setDeletedTokens(deletedRes.tokens || []);
      setJob(jobRes);
      setMonitorStatus(statusRes);
      setUnauthorized(false);
      setLastUpdatedAt(new Date());
    } catch (err: unknown) {
      const status = (err as { status?: number } | null)?.status;
      if (status === 401) {
        setUnauthorized(true);
      }
      setError(err instanceof Error ? err.message : String(err || 'Keeper request failed'));
    } finally {
      setLoading(false);
    }
  }, []);

  useHeaderRefresh(() => loadAll('cache'));

  useEffect(() => {
    void loadAll('cache');
  }, [loadAll]);

  useEffect(() => {
    const onUnauthorized = () => setUnauthorized(true);
    window.addEventListener('keeper-unauthorized', onUnauthorized);
    return () => window.removeEventListener('keeper-unauthorized', onUnauthorized);
  }, []);

  useInterval(() => {
    void Promise.all([loadJob(), loadMonitorStatus()]).catch(() => {});
  }, job?.running ? 3000 : 10000);

  const visibleTokens = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    if (!keyword) return tokens;
    return tokens.filter((token) =>
      [token.name, token.email, token.account_id, token.keeper_status, token.last_check_error]
        .map((value) => String(value || '').toLowerCase())
        .some((value) => value.includes(keyword))
    );
  }, [search, tokens]);

  const summary = useMemo(() => summarizeTokens(tokens), [tokens]);
  const monitorLastPoll = monitorStatus?.last_poll;

  const handleSavePassword = () => {
    keeperApi.setPassword(password);
    setUnauthorized(false);
    void loadAll('cache');
  };

  const runAction = async (key: string, action: () => Promise<unknown>) => {
    setActionLoading(key);
    setError('');
    try {
      await action();
      await loadAll('cache');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err || 'Action failed'));
    } finally {
      setActionLoading('');
    }
  };

  const requireConfirm = (message: string) => window.confirm(message);

  const actionDisabled = Boolean(actionLoading) || Boolean(job?.running);

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.pageTitle}>{t('codex_keeper.title', { defaultValue: 'Codex Keeper' })}</h1>
          <p className={styles.subtitle}>
            {t('codex_keeper.subtitle', {
              defaultValue: 'Token 维护、额度巡检和 sidecar 监控后端统一入口'
            })}
          </p>
        </div>
        <div className={styles.headerActions}>
          <Button variant="secondary" size="sm" onClick={() => void loadAll('cache')} disabled={loading}>
            {t('common.refresh', { defaultValue: '刷新' })}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => void loadAll('live')} disabled={loading || Boolean(job?.running)}>
            {t('codex_keeper.live_scan', { defaultValue: '实时扫描' })}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => runAction('dry-run', () => keeperApi.run(true))}
            loading={actionLoading === 'dry-run'}
            disabled={actionDisabled}
          >
            {t('codex_keeper.dry_run', { defaultValue: 'Dry Run' })}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() =>
              requireConfirm(t('codex_keeper.apply_confirm', { defaultValue: '确认执行自动维护吗？' })) &&
              runAction('apply', () => keeperApi.run(false))
            }
            loading={actionLoading === 'apply'}
            disabled={actionDisabled}
          >
            {t('codex_keeper.apply', { defaultValue: '执行维护' })}
          </Button>
          <Button
            variant="danger"
            size="sm"
            onClick={() => runAction('stop', () => keeperApi.stop())}
            loading={actionLoading === 'stop'}
            disabled={!job?.running || Boolean(actionLoading)}
          >
            {t('common.stop', { defaultValue: '停止' })}
          </Button>
          {lastUpdatedAt && <span className={styles.lastUpdated}>{lastUpdatedAt.toLocaleTimeString()}</span>}
        </div>
      </div>

      {unauthorized && (
        <Card className={styles.passwordCard} title={t('codex_keeper.password_title', { defaultValue: 'Keeper 访问密码' })}>
          <div className={styles.passwordRow}>
            <Input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={t('codex_keeper.password_placeholder', { defaultValue: 'KEEPER_WEB_PASSWORD' })}
            />
            <Button onClick={handleSavePassword}>{t('common.save', { defaultValue: '保存' })}</Button>
          </div>
        </Card>
      )}

      {error && <div className={styles.errorBox}>{error}</div>}
      {loading && !tokens.length && (
        <div className={styles.loading}>
          <LoadingSpinner size={28} />
          <span>{t('common.loading')}</span>
        </div>
      )}

      <div className={styles.statsGrid}>
        <Card className={styles.statCard}>
          <span className={styles.statLabel}>{t('codex_keeper.total_tokens', { defaultValue: '凭证总数' })}</span>
          <strong>{summary.total}</strong>
          <span>{summary.enabled} enabled / {summary.disabled} disabled</span>
        </Card>
        <Card className={styles.statCard}>
          <span className={styles.statLabel}>{t('codex_keeper.quota_risk', { defaultValue: '额度风险' })}</span>
          <strong>{summary.noQuota}</strong>
          <span>{summary.warning} warning / {summary.error} check failed</span>
        </Card>
        <Card className={styles.statCard}>
          <span className={styles.statLabel}>{t('codex_keeper.sidecar_events', { defaultValue: 'Sidecar 事件' })}</span>
          <strong>{monitorStatus?.stored_events?.toLocaleString() || '0'}</strong>
          <span>{monitorLastPoll?.mode || '-'}</span>
        </Card>
        <Card className={styles.statCard}>
          <span className={styles.statLabel}>{t('codex_keeper.job_status', { defaultValue: '维护任务' })}</span>
          <strong>{job?.running ? t('common.running', { defaultValue: '运行中' }) : t('common.idle', { defaultValue: '空闲' })}</strong>
          <span>{job?.mode || '-'}</span>
        </Card>
      </div>

      <Card
        title={t('codex_keeper.monitor_backend', { defaultValue: 'Sidecar 监控后端' })}
        extra={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => runAction('monitor-poll', () => keeperApi.pollMonitorOnce())}
            loading={actionLoading === 'monitor-poll'}
            disabled={Boolean(actionLoading)}
          >
            {t('codex_keeper.poll_once', { defaultValue: '立即消费队列' })}
          </Button>
        }
      >
        <div className={styles.monitorGrid}>
          <div><span>DB</span><strong title={monitorStatus?.db_path}>{monitorStatus?.db_path || '-'}</strong></div>
          <div><span>Poll</span><strong>{monitorStatus?.poll_seconds || '-'}s / {monitorStatus?.batch_size || '-'}</strong></div>
          <div><span>Newest</span><strong>{formatMsDateTime(monitorStatus?.newest_timestamp_ms)}</strong></div>
          <div><span>Last</span><strong>{monitorLastPoll?.at ? formatDateTime(monitorLastPoll.at) : '-'}</strong></div>
        </div>
        {monitorLastPoll?.error && <div className={styles.warnBox}>{monitorLastPoll.error}</div>}
      </Card>

      <Card
        title={t('codex_keeper.tokens_title', { defaultValue: 'Codex 凭证' })}
        extra={
          <div className={styles.tableActions}>
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t('common.search', { defaultValue: '搜索' })}
              className={styles.searchInput}
            />
          </div>
        }
      >
        {!visibleTokens.length ? (
          <EmptyState
            title={t('codex_keeper.no_tokens', { defaultValue: '暂无凭证' })}
            description={t('codex_keeper.no_tokens_desc', { defaultValue: '点击实时扫描从 CPA 拉取最新凭证。' })}
          />
        ) : (
          <div className={styles.tableScroller}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>{t('common.name', { defaultValue: '名称' })}</th>
                  <th>Email</th>
                  <th>{t('common.status', { defaultValue: '状态' })}</th>
                  <th>{t('codex_keeper.usage', { defaultValue: '额度' })}</th>
                  <th>{t('codex_keeper.expiry', { defaultValue: '过期' })}</th>
                  <th>{t('common.actions', { defaultValue: '操作' })}</th>
                </tr>
              </thead>
              <tbody>
                {visibleTokens.map((token) => {
                  const status = getTokenStatus(token);
                  const used = usageUsedPercent(token);
                  return (
                    <tr key={token.name}>
                      <td className={styles.nameCell} title={token.name}>{token.name || '-'}</td>
                      <td className={styles.emailCell} title={token.email}>{token.email || '-'}</td>
                      <td>
                        <span className={`${styles.statusPill} ${status.className}`}>{status.label}</span>
                        {token.last_check_error && <div className={styles.rowHint}>{token.last_check_error}</div>}
                      </td>
                      <td>
                        <div className={styles.quotaCell}>
                          <span>{used === null ? '-' : `${Math.max(0, 100 - used).toFixed(0)}% left`}</span>
                          <small>
                            5h {formatPercent(token.usage?.primary_used_percent)} / week {formatPercent(token.usage?.secondary_used_percent)}
                          </small>
                        </div>
                      </td>
                      <td>
                        <div>{token.remaining || '-'}</div>
                        <small>{token.expiry || ''}</small>
                      </td>
                      <td>
                        <div className={styles.rowActions}>
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => runAction(`usage-${token.name}`, () => keeperApi.refreshTokenUsage([token.name]))}
                            loading={actionLoading === `usage-${token.name}`}
                            disabled={actionDisabled}
                          >
                            {t('codex_keeper.refresh_usage', { defaultValue: '额度' })}
                          </Button>
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => runAction(`refresh-${token.name}`, () => keeperApi.refreshTokens([token.name]))}
                            loading={actionLoading === `refresh-${token.name}`}
                            disabled={actionDisabled}
                          >
                            Refresh
                          </Button>
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => runAction(`disable-${token.name}`, () => keeperApi.setTokenDisabled(token.name, !token.disabled))}
                            loading={actionLoading === `disable-${token.name}`}
                            disabled={actionDisabled}
                          >
                            {token.disabled ? t('common.enable', { defaultValue: '启用' }) : t('common.disable', { defaultValue: '禁用' })}
                          </Button>
                          <Button
                            variant="danger"
                            size="sm"
                            onClick={() =>
                              requireConfirm(t('codex_keeper.delete_confirm', { defaultValue: '确认删除该 token 吗？' })) &&
                              runAction(`delete-${token.name}`, () => keeperApi.deleteTokens([token.name]))
                            }
                            loading={actionLoading === `delete-${token.name}`}
                            disabled={actionDisabled}
                          >
                            {t('common.delete', { defaultValue: '删除' })}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className={styles.bottomGrid}>
        <Card title={t('codex_keeper.deleted_tokens', { defaultValue: '已删除凭证' })}>
          {!deletedTokens.length ? (
            <EmptyState
              title={t('codex_keeper.no_deleted_tokens', { defaultValue: '暂无已删除凭证' })}
              description={t('codex_keeper.no_deleted_tokens_desc', { defaultValue: 'Keeper 会归档由它删除的 token，便于恢复。' })}
            />
          ) : (
            <div className={styles.deletedList}>
              {deletedTokens.map((token) => (
                <div className={styles.deletedItem} key={token.name}>
                  <div>
                    <strong title={token.name}>{token.name}</strong>
                    <span>{token.email || '-'}</span>
                    <small>{formatDateTime(token.deleted_at)} · {token.availability_status || 'unknown'}</small>
                  </div>
                  <div className={styles.rowActions}>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => runAction(`check-deleted-${token.name}`, () => keeperApi.checkDeletedTokens([token.name]))}
                      disabled={Boolean(actionLoading)}
                    >
                      Check
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => runAction(`restore-${token.name}`, () => keeperApi.restoreDeletedTokens([token.name]))}
                      disabled={Boolean(actionLoading)}
                    >
                      Restore
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() =>
                        requireConfirm(t('codex_keeper.delete_archive_confirm', { defaultValue: '确认永久删除归档记录吗？' })) &&
                        runAction(`delete-archive-${token.name}`, () => keeperApi.deleteDeletedTokens([token.name]))
                      }
                      disabled={Boolean(actionLoading)}
                    >
                      Delete
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card title={t('codex_keeper.logs', { defaultValue: '运行日志' })}>
          <div className={styles.logMeta}>
            <span>{job?.running ? 'running' : 'idle'}</span>
            <span>{job?.error || ''}</span>
          </div>
          <pre className={styles.logs}>{job?.logs?.length ? job.logs.join('\n') : t('codex_keeper.no_logs', { defaultValue: '暂无日志' })}</pre>
        </Card>
      </div>
    </div>
  );
}


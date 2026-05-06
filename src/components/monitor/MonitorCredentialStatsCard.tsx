import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { CODEX_CONFIG } from '@/components/quota';
import { keeperApi, type KeeperToken } from '@/services/api/keeper';
import { useQuotaStore } from '@/stores';
import type { CodexQuotaState } from '@/types';
import type { AuthFileItem as AuthFileMeta } from '@/types/authFile';
import type { UsagePayload } from '@/components/usage';
import { isCodexFile } from '@/utils/quota';
import {
  calculateCost,
  collectUsageDetails,
  extractTotalTokens,
  formatCompactNumber,
  formatUsd,
  normalizeAuthIndex,
  type ModelPrice
} from '@/utils/usage';
import styles from '@/pages/MonitoringCenterPage.module.scss';

const ALL_FILTER = '__all__';
const KEEPER_QUOTA_CACHE_POLL_MS = 60_000;
const FIVE_HOUR_SECONDS = 5 * 60 * 60;
const WEEK_SECONDS = 7 * 24 * 60 * 60;

type SortKey =
  | 'displayName'
  | 'requests'
  | 'tokens'
  | 'successRate'
  | 'cost';
type SortDir = 'asc' | 'desc';

interface MonitorCredentialStatsCardProps {
  usage: UsagePayload | null;
  windowUsageSource?: UsagePayload | null;
  loading: boolean;
  modelPrices: Record<string, ModelPrice>;
  authFiles: AuthFileMeta[];
}

interface CredentialRow {
  key: string;
  displayName: string;
  type: string;
  authIndex: string | null;
  authFileName: string | null;
  requests: number;
  successCount: number;
  failureCount: number;
  tokens: number;
  cost: number;
  successRate: number;
  quotaKey: string | null;
}

interface WindowUsageStats {
  id: string;
  label: string;
  resetLabel: string;
  requests: number | null;
  tokens: number | null;
}

type CredentialHealth = 'normal' | 'exhausted' | 'disabled';
type CachedWindowMeta = {
  id: string;
  labelKey: string;
  windowKind: NonNullable<CodexQuotaState['windows'][number]['windowKind']>;
};

const isCodexAuthFile = (file: AuthFileMeta | undefined) => Boolean(file && isCodexFile(file));

const getCodexPlanLabel = (planType: string | null | undefined, t: ReturnType<typeof useTranslation>['t']) => {
  const normalized = typeof planType === 'string' ? planType.trim().toLowerCase() : '';
  if (normalized === 'pro') return t('codex_quota.plan_pro');
  if (normalized === 'pro_lite' || normalized === 'prolite' || normalized === 'pro-lite') {
    return t('codex_quota.plan_prolite');
  }
  if (normalized === 'plus') return t('codex_quota.plan_plus');
  if (normalized === 'team') return t('codex_quota.plan_team');
  if (normalized === 'free') return t('codex_quota.plan_free');
  return planType || '--';
};

const normalizeCredentialType = (file?: AuthFileMeta) => {
  const rawType =
    typeof file?.type === 'string'
      ? file.type
      : typeof file?.provider === 'string'
        ? file.provider
        : '';
  return rawType.trim().toLowerCase() || 'unknown';
};

const normalizePercent = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : null;
};

const normalizePositiveNumber = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const formatCachedResetLabel = (resetAtUnix: number | null) => {
  if (!resetAtUnix) return '-';
  const date = new Date(resetAtUnix * 1000);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString();
};

const getCachedWindowMeta = (
  slot: 'primary' | 'secondary',
  windowSeconds: number | null
): CachedWindowMeta => {
  if (windowSeconds === FIVE_HOUR_SECONDS) {
    return { id: 'five-hour', labelKey: 'codex_quota.primary_window', windowKind: 'five-hour' };
  }
  if (windowSeconds === WEEK_SECONDS) {
    return { id: 'weekly', labelKey: 'codex_quota.secondary_window', windowKind: 'weekly' };
  }
  return slot === 'secondary'
    ? { id: 'weekly', labelKey: 'codex_quota.secondary_window', windowKind: 'weekly' }
    : { id: 'five-hour', labelKey: 'codex_quota.primary_window', windowKind: 'five-hour' };
};

const buildCachedCodexQuotaState = (
  token: KeeperToken,
  t: ReturnType<typeof useTranslation>['t']
): CodexQuotaState | null => {
  const usage = token.usage || {};
  const planType = typeof usage.plan_type === 'string' ? usage.plan_type : undefined;
  const windows: CodexQuotaState['windows'] = [];
  const seen = new Set<string>();

  ([
    {
      slot: 'primary' as const,
      used: usage.primary_used_percent,
      windowSeconds: usage.primary_window_seconds,
      resetAt: usage.primary_reset_at,
    },
    {
      slot: 'secondary' as const,
      used: usage.secondary_used_percent,
      windowSeconds: usage.secondary_window_seconds,
      resetAt: usage.secondary_reset_at,
    },
  ]).forEach((item) => {
    const usedPercent = normalizePercent(item.used);
    if (usedPercent === null) return;
    const windowSeconds = normalizePositiveNumber(item.windowSeconds);
    const meta = getCachedWindowMeta(item.slot, windowSeconds);
    if (seen.has(meta.id)) return;
    seen.add(meta.id);
    const resetAtUnix = normalizePositiveNumber(item.resetAt);
    windows.push({
      ...meta,
      label: t(meta.labelKey),
      usedPercent,
      resetLabel: formatCachedResetLabel(resetAtUnix),
      resetAtUnix,
      windowSeconds,
    });
  });

  if (windows.length === 0) return null;
  return {
    status: 'success',
    windows,
    planType: planType || undefined,
  };
};

const toWindowRange = (endMs: number | null, windowMs: number | null) => {
  if (!windowMs || !endMs || !Number.isFinite(endMs) || endMs <= 0) {
    return null;
  }
  return { endMs, startMs: endMs - windowMs };
};

const getWindowDurationMs = (window: CodexQuotaState['windows'][number]) => {
  if (typeof window.windowSeconds === 'number' && window.windowSeconds > 0) {
    return window.windowSeconds * 1000;
  }
  if (window.id === 'five-hour') return 5 * 60 * 60 * 1000;
  if (window.id === 'weekly') return 7 * 24 * 60 * 60 * 1000;
  return null;
};

const getCredentialHealth = (file?: AuthFileMeta): CredentialHealth => {
  if (file?.disabled === true) return 'disabled';
  if (file?.unavailable === true) return 'exhausted';
  return 'normal';
};

export function MonitorCredentialStatsCard({
  usage,
  windowUsageSource,
  loading,
  modelPrices,
  authFiles
}: MonitorCredentialStatsCardProps) {
  const { t } = useTranslation();
  const [refreshingKeys, setRefreshingKeys] = useState<Record<string, boolean>>({});
  const [sortKey, setSortKey] = useState<SortKey>('tokens');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [typeFilter, setTypeFilter] = useState(ALL_FILTER);
  const [searchTerm, setSearchTerm] = useState('');
  const [keeperTokens, setKeeperTokens] = useState<KeeperToken[]>([]);
  const codexQuota = useQuotaStore((state) => state.codexQuota);
  const setCodexQuota = useQuotaStore((state) => state.setCodexQuota);

  const loadKeeperQuotaCache = useCallback(async () => {
    try {
      const data = await keeperApi.listTokens(false);
      setKeeperTokens(Array.isArray(data.tokens) ? data.tokens : []);
    } catch {
      // Keeper cache is an optimization; failed auth/network must not block usage stats.
    }
  }, []);

  useEffect(() => {
    void loadKeeperQuotaCache();
    const timer = window.setInterval(() => void loadKeeperQuotaCache(), KEEPER_QUOTA_CACHE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [loadKeeperQuotaCache]);

  const rows = useMemo((): CredentialRow[] => {
    if (!usage) return [];

    const details = collectUsageDetails(usage);
    const authIndexToFile = new Map<string, AuthFileMeta>();
    const authFileNameToFile = new Map<string, AuthFileMeta>();

    authFiles.forEach((file) => {
      const authIndex = normalizeAuthIndex(file['auth_index'] ?? file.authIndex);
      if (authIndex) {
        authIndexToFile.set(authIndex, file);
      }
      if (file.name) {
        authFileNameToFile.set(file.name, file);
      }
    });

    const rowMap = new Map<string, CredentialRow>();

    details.forEach((detail) => {
      const authIndex = normalizeAuthIndex(detail.auth_index);
      const sourceRaw = String(detail.source ?? '').trim();
      const sourceText = sourceRaw.startsWith('t:') ? sourceRaw.slice(2) : sourceRaw;
      const matchedFile =
        (authIndex ? authIndexToFile.get(authIndex) : undefined) ??
        (sourceRaw ? authFileNameToFile.get(sourceRaw) : undefined) ??
        (sourceText ? authFileNameToFile.get(sourceText) : undefined);

      if (!matchedFile) {
        return;
      }

      const resolvedAuthIndex =
        normalizeAuthIndex(matchedFile['auth_index'] ?? matchedFile.authIndex) ?? authIndex;
      const authFileName = matchedFile.name ?? null;

      const rowKey = authFileName ? `file:${authFileName}` : `auth:${resolvedAuthIndex}`;
      const displayName = authFileName ?? resolvedAuthIndex ?? '-';
      const type = normalizeCredentialType(matchedFile);
      const existing = rowMap.get(rowKey) ?? {
        key: rowKey,
        displayName,
        type,
        authIndex: resolvedAuthIndex ?? null,
        authFileName,
        requests: 0,
        successCount: 0,
        failureCount: 0,
        tokens: 0,
        cost: 0,
        successRate: 100,
        quotaKey: matchedFile && isCodexAuthFile(matchedFile) ? matchedFile.name : null
      };

      existing.requests += 1;
      if (detail.failed === true) {
        existing.failureCount += 1;
      } else {
        existing.successCount += 1;
      }
      existing.tokens += extractTotalTokens(detail);
      existing.cost += calculateCost(detail, modelPrices);
      existing.successRate =
        existing.requests > 0 ? (existing.successCount / existing.requests) * 100 : 100;
      rowMap.set(rowKey, existing);
    });

    return Array.from(rowMap.values());
  }, [authFiles, modelPrices, usage]);

  const typeOptions = useMemo(
    () => [
      { value: ALL_FILTER, label: t('usage_stats.filter_all') },
      ...Array.from(new Set(authFiles.map((file) => normalizeCredentialType(file))))
        .sort((a, b) => a.localeCompare(b))
        .map((type) => ({ value: type, label: type }))
    ],
    [authFiles, t]
  );

  const typeOptionSet = useMemo(
    () => new Set(typeOptions.map((option) => option.value)),
    [typeOptions]
  );
  const effectiveTypeFilter = typeOptionSet.has(typeFilter) ? typeFilter : ALL_FILTER;
  const normalizedSearchTerm = searchTerm.trim().toLowerCase();

  const filteredRows = useMemo(
    () =>
      rows.filter((row) => {
        const typeMatched = effectiveTypeFilter === ALL_FILTER || row.type === effectiveTypeFilter;
        const nameMatched =
          !normalizedSearchTerm || row.displayName.toLowerCase().includes(normalizedSearchTerm);
        return typeMatched && nameMatched;
      }),
    [effectiveTypeFilter, normalizedSearchTerm, rows]
  );

  const filteredAuthFiles = useMemo(
    () =>
      authFiles.filter((file) =>
        effectiveTypeFilter === ALL_FILTER || normalizeCredentialType(file) === effectiveTypeFilter
      ),
    [authFiles, effectiveTypeFilter]
  );

  const credentialStats = useMemo(
    () =>
      filteredAuthFiles.reduce(
        (acc, file) => {
          const health = getCredentialHealth(file);
          acc[health] += 1;
          return acc;
        },
        { normal: 0, exhausted: 0, disabled: 0 } as Record<CredentialHealth, number>
      ),
    [filteredAuthFiles]
  );

  const resolveQuotaKey = useCallback(
    (row: CredentialRow): string | null => {
      if (row.quotaKey && (codexQuota[row.quotaKey] || authFiles.some((file) => file.name === row.quotaKey))) {
        return row.quotaKey;
      }
      if (row.authFileName) {
        if (codexQuota[row.authFileName]) {
          return row.authFileName;
        }
        const matchedByName = authFiles.find(
          (file) => isCodexAuthFile(file) && file.name === row.authFileName
        );
        if (matchedByName) {
          return matchedByName.name;
        }
      }
      if (row.authIndex) {
        const matchedByAuthIndex = authFiles.find(
          (file) =>
            isCodexAuthFile(file) &&
            normalizeAuthIndex(file['auth_index'] ?? file.authIndex) === row.authIndex
        );
        if (matchedByAuthIndex) {
          return matchedByAuthIndex.name;
        }
      }
      if (codexQuota[row.displayName]) {
        return row.displayName;
      }
      return null;
    },
    [authFiles, codexQuota]
  );

  const handleRefreshQuota = useCallback(
    async (row: CredentialRow) => {
      const quotaKey = resolveQuotaKey(row);
      if (!quotaKey) return;
      const authFile = authFiles.find((file) => file.name === quotaKey);
      if (!authFile) return;

      setRefreshingKeys((prev) => ({ ...prev, [quotaKey]: true }));
      setCodexQuota((prev) => ({
        ...prev,
        [quotaKey]: CODEX_CONFIG.buildLoadingState()
      }));

      try {
        const data = await CODEX_CONFIG.fetchQuota(authFile, t);
        setCodexQuota((prev) => ({
          ...prev,
          [quotaKey]: CODEX_CONFIG.buildSuccessState(data)
        }));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : t('common.unknown_error');
        const status =
          typeof err === 'object' && err !== null && 'status' in err
            ? Number((err as { status?: unknown }).status)
            : undefined;
        setCodexQuota((prev) => ({
          ...prev,
          [quotaKey]: CODEX_CONFIG.buildErrorState(
            message,
            Number.isFinite(status) ? status : undefined
          )
        }));
      } finally {
        setRefreshingKeys((prev) => ({ ...prev, [quotaKey]: false }));
      }
    },
    [authFiles, resolveQuotaKey, setCodexQuota, t]
  );

  const cachedQuotaByName = useMemo(() => {
    const map = new Map<string, CodexQuotaState>();
    keeperTokens.forEach((token) => {
      const name = String(token.name || '').trim();
      if (!name || token.deleted === true) return;
      const quota = buildCachedCodexQuotaState(token, t);
      if (quota) {
        map.set(name, quota);
      }
    });
    return map;
  }, [keeperTokens, t]);

  const quotaByName = useMemo(() => {
    const merged = new Map(cachedQuotaByName);
    Object.entries(codexQuota).forEach(([name, state]) => {
      if (state) {
        merged.set(name, state);
      }
    });
    return merged;
  }, [cachedQuotaByName, codexQuota]);

  const getQuotaState = useCallback(
    (quotaKey: string | null): CodexQuotaState | undefined =>
      quotaKey ? quotaByName.get(quotaKey) : undefined,
    [quotaByName]
  );

  const rowEvents = useMemo(() => {
    const details = collectUsageDetails(windowUsageSource ?? usage);
    const buckets = new Map<string, Array<{ timestampMs: number; tokens: number }>>();
    const rowKeyByAuthIndex = new Map<string, string>();
    const rowKeyBySource = new Map<string, string>();

    rows.forEach((row) => {
      buckets.set(row.key, []);
      if (row.authIndex) {
        rowKeyByAuthIndex.set(row.authIndex, row.key);
      }
      if (row.authFileName) {
        rowKeyBySource.set(row.authFileName, row.key);
      }
    });

    details.forEach((detail) => {
      const authIndex = normalizeAuthIndex(detail.auth_index);
      const sourceRaw = String(detail.source ?? '').trim();
      const sourceText = sourceRaw.startsWith('t:') ? sourceRaw.slice(2) : sourceRaw;
      const rowKey =
        (authIndex ? rowKeyByAuthIndex.get(authIndex) : undefined) ??
        (sourceRaw ? rowKeyBySource.get(sourceRaw) : undefined) ??
        (sourceText ? rowKeyBySource.get(sourceText) : undefined);
      if (!rowKey) return;
      const timestampMs = detail.__timestampMs ?? Date.parse(detail.timestamp);
      if (!Number.isFinite(timestampMs) || timestampMs <= 0) return;
      buckets.get(rowKey)?.push({ timestampMs, tokens: extractTotalTokens(detail) });
    });

    return buckets;
  }, [rows, usage, windowUsageSource]);

  const windowUsage = useMemo(() => {
    const result = new Map<string, WindowUsageStats[]>();

    rows.forEach((row) => {
      const quotaKey = resolveQuotaKey(row);
      const quotaState = getQuotaState(quotaKey);
      const events = rowEvents.get(row.key) ?? [];
      const stats = (quotaState?.windows ?? [])
        .filter((window) => window.id === 'five-hour' || window.id === 'weekly')
        .map((window) => {
          const range = toWindowRange(
            window.resetAtUnix ? window.resetAtUnix * 1000 : null,
            getWindowDurationMs(window)
          );
          const label = window.labelKey ? t(window.labelKey, window.labelParams ?? {}) : window.label;
          if (!range) {
            return {
              id: window.id,
              label,
              resetLabel: window.resetLabel,
              requests: null,
              tokens: null
            };
          }
          const totals = events.reduce(
            (sum, item) => {
              if (item.timestampMs >= range.startMs && item.timestampMs <= range.endMs) {
                sum.requests += 1;
                sum.tokens += item.tokens;
              }
              return sum;
            },
            { requests: 0, tokens: 0 }
          );
          return {
            id: window.id,
            label,
            resetLabel: window.resetLabel,
            requests: totals.requests,
            tokens: totals.tokens
          };
        });

      result.set(row.key, stats);
    });

    return result;
  }, [getQuotaState, resolveQuotaKey, rowEvents, rows, t]);

  const handleSort = useCallback(
    (key: SortKey) => {
      if (sortKey === key) {
        setSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'));
        return;
      }
      setSortKey(key);
      setSortDir(key === 'displayName' ? 'asc' : 'desc');
    },
    [sortKey]
  );

  const getSortValue = useCallback(
    (row: CredentialRow, key: SortKey) => {
      if (key === 'displayName') {
        return row.displayName;
      }
      return row[key];
    },
    []
  );

  const sortedRows = useMemo(() => {
    const direction = sortDir === 'asc' ? 1 : -1;
    return [...filteredRows].sort((a, b) => {
      const aValue = getSortValue(a, sortKey);
      const bValue = getSortValue(b, sortKey);

      if (typeof aValue === 'string' && typeof bValue === 'string') {
        return direction * aValue.localeCompare(bValue);
      }

      return direction * (Number(aValue) - Number(bValue));
    });
  }, [filteredRows, getSortValue, sortDir, sortKey]);

  const arrow = (key: SortKey) =>
    sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';

  const ariaSort = (key: SortKey): 'none' | 'ascending' | 'descending' =>
    sortKey === key ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none';

  return (
    <Card title={t('usage_stats.credential_stats')} className={`${styles.detailsFixedCard} ${styles.credentialStatsCard} ${styles.fullWidthSection}`}>
      <div className={styles.requestEventsToolbar}>
        <div className={styles.requestEventsFilterItem}>
          <span className={styles.requestEventsFilterLabel}>
            {t('monitoring_center.credential_filter_type')}
          </span>
          <Select
            value={effectiveTypeFilter}
            options={typeOptions}
            onChange={setTypeFilter}
            className={styles.requestEventsSelect}
            ariaLabel={t('monitoring_center.credential_filter_type')}
            fullWidth={false}
          />
        </div>
        <div className={`${styles.requestEventsFilterItem} ${styles.toolbarInputItem}`}>
          <span className={styles.requestEventsFilterLabel}>
            {t('monitoring_center.credential_search_label')}
          </span>
          <div className={`${styles.toolbarInputControl} ${styles.credentialSearchGroup}`}>
            <Input
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.currentTarget.value)}
              placeholder={t('monitoring_center.credential_search_placeholder')}
              aria-label={t('monitoring_center.credential_search_label')}
              className={styles.credentialSearchInput}
            />
            <div className={styles.credentialStatsInline} aria-label={t('monitoring_center.credential_stats_label')}>
              <span className={styles.credentialStatChip}>
                {t('monitoring_center.credential_status_normal')}
                <strong>{credentialStats.normal}</strong>
              </span>
              <span className={styles.credentialStatChip}>
                {t('monitoring_center.credential_status_exhausted')}
                <strong>{credentialStats.exhausted}</strong>
              </span>
              <span className={styles.credentialStatChip}>
                {t('monitoring_center.credential_status_disabled')}
                <strong>{credentialStats.disabled}</strong>
              </span>
            </div>
          </div>
        </div>
      </div>

      {loading ? (
        <div className={styles.hint}>{t('common.loading')}</div>
      ) : rows.length > 0 ? (
        filteredRows.length > 0 ? (
          <div className={styles.detailsScroll}>
            <div className={styles.tableWrapper}>
              <table className={styles.table}>
                <colgroup>
                  <col className={styles.credentialNameCol} />
                  <col className={styles.credentialActionCol} />
                  <col className={styles.windowUsageCol} />
                  <col className={styles.metricCol} />
                  <col className={styles.metricCol} />
                  <col className={styles.metricCol} />
                  <col className={styles.metricCol} />
                </colgroup>
                <thead>
                  <tr>
                    <th className={`${styles.sortableHeader} ${styles.credentialNameColumn}`} aria-sort={ariaSort('displayName')}>
                      <button
                        type="button"
                        className={styles.sortHeaderButton}
                        onClick={() => handleSort('displayName')}
                      >
                        {t('usage_stats.credential_name')}{arrow('displayName')}
                      </button>
                    </th>
                    <th className={styles.credentialActionHeader}></th>
                    <th className={styles.windowUsageColumn}>
                      {t('monitoring_center.window_usage', { defaultValue: '窗口用量' })}
                    </th>
                    <th className={`${styles.sortableHeader} ${styles.metricColumn}`} aria-sort={ariaSort('requests')}>
                      <button
                        type="button"
                        className={styles.sortHeaderButton}
                        onClick={() => handleSort('requests')}
                      >
                        {t('usage_stats.requests_count')}{arrow('requests')}
                      </button>
                    </th>
                    <th className={`${styles.sortableHeader} ${styles.metricColumn}`} aria-sort={ariaSort('tokens')}>
                      <button
                        type="button"
                        className={styles.sortHeaderButton}
                        onClick={() => handleSort('tokens')}
                      >
                        {t('usage_stats.tokens_count')}{arrow('tokens')}
                      </button>
                    </th>
                    <th className={`${styles.sortableHeader} ${styles.metricColumn}`} aria-sort={ariaSort('successRate')}>
                      <button
                        type="button"
                        className={styles.sortHeaderButton}
                        onClick={() => handleSort('successRate')}
                      >
                        {t('usage_stats.success_rate')}{arrow('successRate')}
                      </button>
                    </th>
                    <th className={`${styles.sortableHeader} ${styles.metricColumn}`} aria-sort={ariaSort('cost')}>
                      <button
                        type="button"
                        className={styles.sortHeaderButton}
                        onClick={() => handleSort('cost')}
                      >
                        {t('usage_stats.total_cost')}{arrow('cost')}
                      </button>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sortedRows.map((row) => {
                    const resolvedQuotaKey = resolveQuotaKey(row);
                    const quotaState = getQuotaState(resolvedQuotaKey);
                    const quotaWindows = (quotaState?.windows ?? [])
                      .filter((window) => window.id === 'five-hour' || window.id === 'weekly')
                      .map((window) => ({
                        id: window.id,
                        label: window.labelKey ? t(window.labelKey, window.labelParams ?? {}) : window.label,
                        remainingValue:
                          typeof window.usedPercent === 'number'
                            ? Math.max(0, Math.min(100, Math.round(100 - window.usedPercent)))
                            : null,
                        resetLabel: window.resetLabel
                      }));
                    const windowStats = windowUsage.get(row.key) ?? [];
                    const isRefreshing = resolvedQuotaKey ? refreshingKeys[resolvedQuotaKey] === true : false;
                    return (
                      <tr key={row.key}>
                        <td className={styles.modelCell}>
                          <div>
                            <span>{row.displayName}</span>
                            {row.type && <span className={styles.credentialType}>{row.type}</span>}
                          </div>
                        </td>
                        <td className={styles.credentialActionCell}>
                          {resolvedQuotaKey ? (
                            <div className={styles.credentialQuotaInline}>
                              <div className={styles.quotaPlanRow}>
                                <span className={styles.quotaPlanText}>
                                  {getCodexPlanLabel(quotaState?.planType, t)}
                                </span>
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  className={styles.credentialRefreshButton}
                                  loading={isRefreshing}
                                  onClick={() => void handleRefreshQuota(row)}
                                >
                                  {t('common.refresh')}
                                </Button>
                              </div>
                              {quotaWindows.length > 0 ? (
                                <div className={styles.quotaSummary}>
                                  {quotaWindows.map((window) => (
                                    <span
                                      key={window.id}
                                      className={styles.quotaCircleItem}
                                      title={`${window.label} - ${window.resetLabel}`}
                                    >
                                      <span
                                        className={styles.quotaCircle}
                                        style={
                                          {
                                            '--quota-remaining': `${window.remainingValue ?? 0}%`
                                          } as CSSProperties
                                        }
                                      >
                                        <span className={styles.quotaCircleValue}>
                                          {window.remainingValue !== null ? `${window.remainingValue}%` : '--'}
                                        </span>
                                      </span>
                                      <span className={styles.quotaCircleLabel}>{window.label}</span>
                                    </span>
                                  ))}
                                </div>
                              ) : null}
                              {quotaState?.status === 'error' ? (
                                <span className={styles.quotaChipError}>{quotaState.error}</span>
                              ) : null}
                            </div>
                          ) : null}
                        </td>
                        <td className={styles.windowUsageCell}>
                          {windowStats.length > 0 ? (
                            <div className={styles.windowUsageList}>
                              {windowStats.map((item) => (
                                <span
                                  key={item.id}
                                  className={styles.windowUsageRow}
                                  title={`${item.label} - ${item.resetLabel}`}
                                >
                                  <span className={styles.windowUsageLabel}>{item.label}</span>
                                  <span className={styles.windowUsageValue}>
                                    {item.requests !== null ? item.requests.toLocaleString() : '--'}
                                    {t('monitoring_center.window_usage_requests_suffix', { defaultValue: ' 请求' })}
                                  </span>
                                  <span className={styles.windowUsageValue}>
                                    {item.tokens !== null ? formatCompactNumber(item.tokens) : '--'}
                                    {t('monitoring_center.window_usage_tokens_suffix', { defaultValue: ' Token' })}
                                  </span>
                                </span>
                              ))}
                            </div>
                          ) : (
                            '--'
                          )}
                        </td>
                        <td>
                          <span className={styles.requestCountCell}>
                            <span>{row.requests.toLocaleString()}</span>
                            <span className={styles.requestBreakdown}>
                              (<span className={styles.statSuccess}>{row.successCount.toLocaleString()}</span>{' '}
                              <span className={styles.statFailure}>{row.failureCount.toLocaleString()}</span>)
                            </span>
                          </span>
                        </td>
                        <td>{formatCompactNumber(row.tokens)}</td>
                        <td>
                          <span
                            className={
                              row.successRate >= 95
                                ? styles.statSuccess
                                : row.successRate >= 80
                                  ? styles.statNeutral
                                  : styles.statFailure
                            }
                          >
                            {row.successRate.toFixed(1)}%
                          </span>
                        </td>
                        <td>{row.cost > 0 ? formatUsd(row.cost) : '--'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <EmptyState
            title={t('monitoring_center.credential_no_result_title')}
            description={t('monitoring_center.credential_no_result_desc')}
          />
        )
      ) : (
        <div className={styles.hint}>{t('usage_stats.no_data')}</div>
      )}
    </Card>
  );
}

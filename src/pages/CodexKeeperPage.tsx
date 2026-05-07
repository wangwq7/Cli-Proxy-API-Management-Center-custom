import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import {
  keeperApi,
  type KeeperActionResult,
  type KeeperJob,
  type KeeperMonitorStatus,
  type KeeperRunOptions,
  type KeeperRunOverrides,
  type KeeperRunPolicy,
  type KeeperSettings,
  type KeeperToken,
} from '@/services/api/keeper';
import styles from './CodexKeeperPage.module.scss';

const PAGE_SIZE = 10;
const LOG_TAIL_LINES = 220;
const IDLE_TOKEN_POLL_MS = 60_000;
const KEEPER_TOKEN_CACHE_EVENT = 'keeper-token-cache-updated';
const KEEPER_TOKEN_CACHE_VERSION_KEY = 'keeperTokenCacheVersion';

type TokenHealthKey = 'good' | 'warn' | 'noquota' | 'expired' | 'unknown';
type TokenFilter = 'all' | 'enabled' | 'disabled' | 'expired' | 'norefresh' | 'noquota' | 'unknown';
type SummaryKey = 'total' | 'enabled' | 'disabled' | 'expired' | 'noquota' | 'unknown' | 'good' | 'warn' | 'noRefresh' | 'alive';

interface TokenSummary {
  total: number;
  enabled: number;
  disabled: number;
  expired: number;
  noquota: number;
  unknown: number;
  good: number;
  warn: number;
  noRefresh: number;
  alive: number;
}

interface TokenDelta {
  at: number;
  before: TokenSummary;
  after: TokenSummary;
  diff: Record<SummaryKey, number>;
}

interface HealthMeta {
  key: TokenHealthKey;
  label: string;
  className: string;
}

interface StatusMeta {
  text: string;
  tone: 'good' | 'warn' | 'danger' | 'muted' | 'info';
}

const emptyJob: KeeperJob = {
  running: false,
  mode: 'idle',
  logs: [],
  log_total: 0,
  log_version: 0,
  stats: {},
};

const defaultPolicy: Required<KeeperRunPolicy> = {
  invalid_token: 'mark_dead',
  expired_no_refresh: 'disable',
  quota_no_refresh: 'disable',
  quota_reached: 'skip',
  recovered_disabled: 'enable',
  near_expiry: 'refresh',
};

const defaultOverrides: Required<KeeperRunOverrides> = {
  quota_threshold: 100,
  expiry_threshold_days: 3,
  worker_threads: 4,
  enable_refresh: true,
};

const tokenFilterLabels: Record<TokenFilter, string> = {
  all: '全部状态',
  enabled: '正常',
  disabled: '已禁用',
  expired: '已过期/死号',
  norefresh: '无 Refresh',
  noquota: '无额度',
  unknown: '状态未知',
};

const policyOptions: Record<keyof Required<KeeperRunPolicy>, Array<{ value: string; label: string }>> = {
  invalid_token: [
    { value: 'mark_dead', label: '标记为死号并禁用' },
    { value: 'disable', label: '只禁用' },
    { value: 'delete', label: '删除' },
    { value: 'skip', label: '只记录' },
  ],
  expired_no_refresh: [
    { value: 'disable', label: '标记过期并禁用' },
    { value: 'delete', label: '删除' },
    { value: 'skip', label: '只记录' },
  ],
  quota_no_refresh: [
    { value: 'disable', label: '只禁用' },
    { value: 'delete', label: '删除' },
    { value: 'skip', label: '只记录' },
  ],
  quota_reached: [
    { value: 'disable', label: '禁用' },
    { value: 'skip', label: '只记录' },
  ],
  recovered_disabled: [
    { value: 'enable', label: '自动启用' },
    { value: 'skip', label: '只记录' },
  ],
  near_expiry: [
    { value: 'refresh', label: '刷新' },
    { value: 'skip', label: '只记录' },
  ],
};

const policyLabels: Record<keyof Required<KeeperRunPolicy>, { title: string; hint: string }> = {
  invalid_token: {
    title: '死号 / 401 / 402',
    hint: 'OpenAI usage 返回 401/402 时的真实巡检处理方式。',
  },
  expired_no_refresh: {
    title: '已过期且无 Refresh',
    hint: '没有 refresh_token 的过期 token 通常无法自救。',
  },
  quota_no_refresh: {
    title: '无 Refresh 且额度达到阈值',
    hint: '额度满且无法刷新时的处理方式。',
  },
  quota_reached: {
    title: '额度达到阈值',
    hint: '5h 或周额度任一达到阈值会触发。',
  },
  recovered_disabled: {
    title: '已禁用但额度恢复',
    hint: '额度恢复后是否自动启用。',
  },
  near_expiry: {
    title: '快过期 token',
    hint: '需要同时开启刷新权限才会实际刷新。',
  },
};

const summaryKeys: SummaryKey[] = ['total', 'enabled', 'disabled', 'expired', 'noquota', 'unknown', 'good', 'warn', 'noRefresh', 'alive'];

const readJson = <T,>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};

const writeJson = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Local storage is best effort only.
  }
};

const formatError = (error: unknown) => (error instanceof Error ? error.message : String(error || '请求失败'));

const errorStatus = (error: unknown) =>
  typeof error === 'object' && error !== null && 'status' in error ? Number((error as { status?: unknown }).status) : 0;

const isUnauthorized = (error: unknown) => errorStatus(error) === 401 || formatError(error).toLowerCase() === 'unauthorized';

const tokenName = (token: KeeperToken) => String(token.name || '');

const numericPercent = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : null;
};

const usageUsedPercent = (token: KeeperToken): number | null => {
  const usage = token.usage || {};
  const primary = numericPercent(usage.primary_used_percent);
  const secondary = numericPercent(usage.secondary_used_percent);
  if (secondary !== null) return Math.max(primary ?? 0, secondary);
  return primary;
};

const isExpired = (token: KeeperToken) =>
  typeof token.remaining_seconds === 'number' && token.remaining_seconds <= 0;

const isNoRefresh = (token: KeeperToken) => !token.has_refresh_token;

const isDeadToken = (token: KeeperToken) => {
  const status = String(token.keeper_status || '').toLowerCase();
  return Boolean(token.deleted) || isExpired(token) || ['dead', 'expired', 'deleted', 'invalid'].includes(status);
};

const isNoQuota = (token: KeeperToken) => {
  const used = usageUsedPercent(token);
  return used !== null && !isDeadToken(token) && 100 - used < 1;
};

const tokenHealth = (token: KeeperToken): HealthMeta => {
  const used = usageUsedPercent(token);
  if (isDeadToken(token)) return { key: 'expired', label: '过期/死号', className: styles.healthExpired };
  if (isNoQuota(token)) return { key: 'noquota', label: '无额度', className: styles.healthNoquota };
  if (used === null) return { key: 'unknown', label: '状态未知', className: styles.healthUnknown };
  return used < 50
    ? { key: 'good', label: '健康', className: styles.healthGood }
    : { key: 'warn', label: '良好', className: styles.healthWarn };
};

const tokenStatus = (token: KeeperToken): StatusMeta => {
  if (isDeadToken(token)) return { text: '过期/死号', tone: 'danger' };
  if (token.disabled) return { text: '已禁用', tone: 'warn' };
  if (isNoQuota(token)) return { text: '无额度', tone: 'warn' };
  if (usageUsedPercent(token) === null) return { text: '状态未知', tone: 'muted' };
  if (isNoRefresh(token)) return { text: '无 Refresh', tone: 'muted' };
  return { text: '正常', tone: 'good' };
};

const availabilityStatus = (token: KeeperToken): StatusMeta => {
  const status = String(token.availability_status || 'unknown');
  if (status === 'available') return { text: '可用', tone: 'good' };
  if (status === 'unavailable') return { text: '不可用', tone: 'danger' };
  return { text: '未验证', tone: 'muted' };
};

const tokenMatchesFilter = (token: KeeperToken, filter: TokenFilter) => {
  if (filter === 'all') return true;
  if (filter === 'enabled') return !token.disabled && !isDeadToken(token) && !isNoQuota(token) && usageUsedPercent(token) !== null;
  if (filter === 'disabled') return Boolean(token.disabled);
  if (filter === 'expired') return isDeadToken(token);
  if (filter === 'norefresh') return isNoRefresh(token);
  if (filter === 'noquota') return isNoQuota(token);
  if (filter === 'unknown') return usageUsedPercent(token) === null && !isDeadToken(token);
  return true;
};

const tokenMatchesQuery = (token: KeeperToken, query: string) => {
  if (!query) return true;
  return [token.name, token.email, token.account_id].join(' ').toLowerCase().includes(query);
};

const inventory = (tokens: KeeperToken[]): TokenSummary => {
  const base: TokenSummary = {
    total: tokens.length,
    enabled: 0,
    disabled: 0,
    expired: 0,
    noquota: 0,
    unknown: 0,
    good: 0,
    warn: 0,
    noRefresh: 0,
    alive: 0,
  };
  tokens.forEach((token) => {
    const health = tokenHealth(token).key;
    base[health] += 1;
    if (token.disabled) base.disabled += 1;
    if (isNoRefresh(token)) base.noRefresh += 1;
  });
  base.enabled = Math.max(0, base.total - base.disabled);
  base.alive = Math.max(0, base.total - base.expired);
  return base;
};

const buildHealthMap = (tokens: KeeperToken[]) =>
  tokens.reduce<Record<string, TokenHealthKey>>((acc, token) => {
    const name = tokenName(token);
    if (name) acc[name] = tokenHealth(token).key;
    return acc;
  }, {});

const changedTokenNames = (beforeMap: Record<string, TokenHealthKey>, tokens: KeeperToken[], limitNames?: Set<string>) => {
  const names: string[] = [];
  tokens.forEach((token) => {
    const name = tokenName(token);
    if (!name || (limitNames && !limitNames.has(name))) return;
    const before = beforeMap[name];
    const after = tokenHealth(token).key;
    if (before && before !== after) names.push(name);
  });
  return names;
};

const buildTokenDelta = (before: TokenSummary | null, after: TokenSummary): TokenDelta | null => {
  if (!before) return null;
  const diff = summaryKeys.reduce<Record<SummaryKey, number>>((acc, key) => {
    acc[key] = (after[key] || 0) - (before[key] || 0);
    return acc;
  }, {} as Record<SummaryKey, number>);
  return { at: Date.now(), before, after, diff };
};

const formatDateTime = (timestampSeconds?: unknown) => {
  if (!timestampSeconds) return '-';
  const date = new Date(Number(timestampSeconds) * 1000);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString('zh-CN', { hour12: false });
};

const cacheTimeText = (timestampSeconds?: number | null) => {
  if (!timestampSeconds) return '暂无上次巡检缓存';
  return `上次巡检结果 ${formatDateTime(timestampSeconds)}`;
};

const usageText = (token: KeeperToken) => {
  const usage = token.usage || {};
  const primary = numericPercent(usage.primary_used_percent);
  const secondary = numericPercent(usage.secondary_used_percent);
  if (primary === null && secondary === null) {
    const reason =
      token.last_check_error ||
      token.keeper_reason ||
      (token.last_checked_at ? '本轮没有拿到 usage 额度数据' : '尚未保存 usage 额度数据');
    return `状态未知：${reason}`;
  }
  const used = usageUsedPercent(token);
  const remaining = used === null ? '-' : `${Math.max(0, Math.round(100 - used))}%`;
  return `5h: ${primary === null ? '-' : `${primary}%`} · Week: ${secondary === null ? '-' : `${secondary}%`} · 剩余: ${remaining}`;
};

const pendingRunToken = (token: KeeperToken): KeeperToken => ({
  ...token,
  remaining: '等待本轮巡检',
  remaining_seconds: null,
  has_refresh_token: true,
  usage: {},
  keeper_status: '',
  keeper_reason: '',
  last_check_error: '等待本轮巡检',
});

const logClassName = (line: string) => {
  const text = String(line || '').toLowerCase();
  if (text.includes('[error]') || text.includes('失败') || text.includes('异常')) return styles.logError;
  if (text.includes('[delete]') || text.includes('删除')) return styles.logDelete;
  if (text.includes('[disable]') || text.includes('禁用')) return styles.logDisable;
  if (text.includes('[warn]') || text.includes('[!]') || text.includes('准备')) return styles.logWarn;
  if (text.includes('[dry-run]') || text.includes('[dry]')) return styles.logDry;
  if (text.includes('[skip]') || text.includes('跳过')) return styles.logSkip;
  if (text.includes('[refresh]') || text.includes('刷新成功')) return styles.logRefresh;
  if (text.includes('[enable]') || text.includes('启用')) return styles.logEnable;
  if (text.includes('[ok]') || text.includes('存活') || text.includes('正常')) return styles.logOk;
  return styles.logInfo;
};

const toneClassName = (tone: StatusMeta['tone']) => {
  if (tone === 'good') return styles.toneGood;
  if (tone === 'warn') return styles.toneWarn;
  if (tone === 'danger') return styles.toneDanger;
  if (tone === 'info') return styles.toneInfo;
  return styles.toneMuted;
};

const deltaText = (value: number) => (value > 0 ? `+${value}` : String(value));

const deltaToneClassName = (key: SummaryKey, value: number) => {
  if (value === 0 || key === 'total') return '';
  if (key === 'enabled' || key === 'alive' || key === 'good') {
    return value > 0 ? styles.deltaGood : styles.deltaBad;
  }
  if (key === 'expired' || key === 'noquota' || key === 'unknown' || key === 'noRefresh') {
    return value < 0 ? styles.deltaGood : styles.deltaBad;
  }
  return '';
};

export function CodexKeeperPage() {
  const { t } = useTranslation();
  const [passwordInput, setPasswordInput] = useState(() => keeperApi.getPassword());
  const [authorized, setAuthorized] = useState(() => Boolean(keeperApi.getPassword()));
  const [settings, setSettings] = useState<KeeperSettings | null>(null);
  const [monitorStatus, setMonitorStatus] = useState<KeeperMonitorStatus | null>(null);
  const [job, setJob] = useState<KeeperJob>(emptyJob);
  const [tokens, setTokens] = useState<KeeperToken[]>([]);
  const [deletedTokens, setDeletedTokens] = useState<KeeperToken[]>([]);
  const [tokenUpdatedAt, setTokenUpdatedAt] = useState<number | null>(null);
  const [deletedUpdatedAt, setDeletedUpdatedAt] = useState<number | null>(null);
  const [tokenQuery, setTokenQuery] = useState('');
  const [deletedQuery, setDeletedQuery] = useState('');
  const [tokenFilter, setTokenFilter] = useState<TokenFilter>('all');
  const [tokenPage, setTokenPage] = useState(1);
  const [deletedPage, setDeletedPage] = useState(1);
  const [selectedTokens, setSelectedTokens] = useState<Set<string>>(() => new Set());
  const [busyAction, setBusyAction] = useState('');
  const [authError, setAuthError] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [policyOpen, setPolicyOpen] = useState(false);
  const [logExpanded, setLogExpanded] = useState(false);
  const [policy, setPolicy] = useState<Required<KeeperRunPolicy>>(defaultPolicy);
  const [overrides, setOverrides] = useState<Required<KeeperRunOverrides>>(defaultOverrides);
  const [runMapActive, setRunMapActive] = useState(false);
  const [runTokenSeq, setRunTokenSeq] = useState(0);
  const [runId, setRunId] = useState(0);
  const [runTokenStates, setRunTokenStates] = useState<Map<string, KeeperToken>>(() => new Map());
  const [lastTokenDelta, setLastTokenDelta] = useState<TokenDelta | null>(() => readJson<TokenDelta | null>('keeperLastTokenDelta', null));
  const [lastChangedTokens, setLastChangedTokens] = useState<Set<string>>(
    () => new Set(readJson<string[]>('keeperLastChangedTokens', []))
  );

  const tokensRef = useRef(tokens);
  const runMapActiveRef = useRef(runMapActive);
  const runTokenSeqRef = useRef(runTokenSeq);
  const runIdRef = useRef(runId);
  const lastTokenPollRef = useRef(0);
  const wasRunningRef = useRef(false);
  const baselineSummaryRef = useRef<TokenSummary | null>(null);
  const baselineHealthMapRef = useRef<Record<string, TokenHealthKey>>({});
  const logBodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    tokensRef.current = tokens;
  }, [tokens]);

  useEffect(() => {
    runMapActiveRef.current = runMapActive;
  }, [runMapActive]);

  useEffect(() => {
    runTokenSeqRef.current = runTokenSeq;
  }, [runTokenSeq]);

  useEffect(() => {
    runIdRef.current = runId;
  }, [runId]);

  useEffect(() => {
    const handleUnauthorized = () => {
      keeperApi.setPassword('');
      setAuthorized(false);
      setAuthError('Keeper 管理密码无效或未设置，请重新输入。');
    };
    window.addEventListener('keeper-unauthorized', handleUnauthorized);
    return () => window.removeEventListener('keeper-unauthorized', handleUnauthorized);
  }, []);

  useEffect(() => {
    const body = logBodyRef.current;
    if (!body) return;
    body.scrollTop = body.scrollHeight;
  }, [job.log_version]);

  const hydrateSettings = useCallback((nextSettings: KeeperSettings) => {
    setPolicy({
      invalid_token: String(nextSettings.policy_invalid_token || defaultPolicy.invalid_token),
      expired_no_refresh: String(nextSettings.policy_expired_no_refresh || defaultPolicy.expired_no_refresh),
      quota_no_refresh: String(nextSettings.policy_quota_no_refresh || defaultPolicy.quota_no_refresh),
      quota_reached: String(nextSettings.policy_quota_reached || defaultPolicy.quota_reached),
      recovered_disabled: String(nextSettings.policy_recovered_disabled || defaultPolicy.recovered_disabled),
      near_expiry: String(nextSettings.policy_near_expiry || defaultPolicy.near_expiry),
    });
    setOverrides({
      quota_threshold: Number(nextSettings.quota_threshold ?? defaultOverrides.quota_threshold),
      expiry_threshold_days: Number(nextSettings.expiry_threshold_days ?? defaultOverrides.expiry_threshold_days),
      worker_threads: defaultOverrides.worker_threads,
      enable_refresh: defaultOverrides.enable_refresh,
    });
  }, []);

  const handleAuthFailure = useCallback((nextError: unknown) => {
    if (!isUnauthorized(nextError)) return false;
    keeperApi.setPassword('');
    setAuthorized(false);
    setAuthError('Keeper 管理密码无效或未设置，请重新输入。');
    return true;
  }, []);

  const loadSettings = useCallback(async () => {
    const data = await keeperApi.getSettings();
    setSettings(data);
    hydrateSettings(data);
    return data;
  }, [hydrateSettings]);

  const loadJob = useCallback(async () => {
    const data = await keeperApi.getJob(LOG_TAIL_LINES);
    setJob(data);
    return data;
  }, []);

  const loadTokens = useCallback(async (live = false) => {
    const data = await keeperApi.listTokens(live);
    const rows = data.tokens || [];
    setTokens(rows);
    setTokenUpdatedAt(data.updated_at ?? null);
    lastTokenPollRef.current = Date.now();
    setSelectedTokens((prev) => {
      if (!prev.size) return prev;
      const valid = new Set(rows.map(tokenName));
      const next = new Set(Array.from(prev).filter((name) => valid.has(name)));
      return next.size === prev.size ? prev : next;
    });
    return rows;
  }, []);

  useEffect(() => {
    if (!authorized) return;

    const reloadTokens = () => {
      void loadTokens(false).catch((nextError) => {
        if (!handleAuthFailure(nextError)) setError(formatError(nextError));
      });
    };
    const handleStorage = (event: StorageEvent) => {
      if (event.key === KEEPER_TOKEN_CACHE_VERSION_KEY) {
        reloadTokens();
      }
    };

    window.addEventListener(KEEPER_TOKEN_CACHE_EVENT, reloadTokens);
    window.addEventListener('storage', handleStorage);
    return () => {
      window.removeEventListener(KEEPER_TOKEN_CACHE_EVENT, reloadTokens);
      window.removeEventListener('storage', handleStorage);
    };
  }, [authorized, handleAuthFailure, loadTokens]);

  const loadDeletedTokens = useCallback(async () => {
    const data = await keeperApi.listDeletedTokens();
    const rows = data.tokens || [];
    setDeletedTokens(rows);
    setDeletedUpdatedAt(data.updated_at ?? null);
    return rows;
  }, []);

  const loadMonitorStatus = useCallback(async () => {
    const data = await keeperApi.getMonitorStatus();
    setMonitorStatus(data);
    return data;
  }, []);

  const refreshAll = useCallback(
    async (liveTokens = false) => {
      if (!authorized) return;
      setLoading(true);
      setError('');
      try {
        await Promise.all([loadSettings(), loadJob(), loadTokens(liveTokens), loadDeletedTokens(), loadMonitorStatus()]);
      } catch (nextError) {
        if (!handleAuthFailure(nextError)) setError(formatError(nextError));
      } finally {
        setLoading(false);
      }
    },
    [authorized, handleAuthFailure, loadDeletedTokens, loadJob, loadMonitorStatus, loadSettings, loadTokens]
  );

  useEffect(() => {
    if (!authorized) return;
    void refreshAll(false);
  }, [authorized, refreshAll]);

  const displayMapTokens = useMemo(() => {
    if (!runMapActive) return tokens;
    return tokens.map((token) => runTokenStates.get(tokenName(token)) || pendingRunToken(token));
  }, [runMapActive, runTokenStates, tokens]);

  const mapSummary = useMemo(() => inventory(displayMapTokens), [displayMapTokens]);
  const tokenSummary = useMemo(() => inventory(tokens), [tokens]);

  const changedForMap = useMemo(() => {
    if (runMapActive) {
      return new Set(changedTokenNames(baselineHealthMapRef.current, displayMapTokens, new Set(runTokenStates.keys())));
    }
    return lastChangedTokens;
  }, [displayMapTokens, lastChangedTokens, runMapActive, runTokenStates]);

  const filteredTokens = useMemo(() => {
    const query = tokenQuery.trim().toLowerCase();
    return tokens.filter((token) => tokenMatchesFilter(token, tokenFilter)).filter((token) => tokenMatchesQuery(token, query));
  }, [tokenFilter, tokenQuery, tokens]);

  const filteredDeletedTokens = useMemo(() => {
    const query = deletedQuery.trim().toLowerCase();
    return deletedTokens.filter((token) => tokenMatchesQuery(token, query));
  }, [deletedQuery, deletedTokens]);

  const tokenPageCount = Math.max(1, Math.ceil(filteredTokens.length / PAGE_SIZE));
  const deletedPageCount = Math.max(1, Math.ceil(filteredDeletedTokens.length / PAGE_SIZE));
  const safeTokenPage = Math.min(Math.max(1, tokenPage), tokenPageCount);
  const safeDeletedPage = Math.min(Math.max(1, deletedPage), deletedPageCount);
  const pagedTokens = filteredTokens.slice((safeTokenPage - 1) * PAGE_SIZE, safeTokenPage * PAGE_SIZE);
  const pagedDeletedTokens = filteredDeletedTokens.slice((safeDeletedPage - 1) * PAGE_SIZE, safeDeletedPage * PAGE_SIZE);

  useEffect(() => {
    if (tokenPage !== safeTokenPage) setTokenPage(safeTokenPage);
  }, [safeTokenPage, tokenPage]);

  useEffect(() => {
    if (deletedPage !== safeDeletedPage) setDeletedPage(safeDeletedPage);
  }, [deletedPage, safeDeletedPage]);

  const runProgress = useMemo(() => {
    const stats = job.stats || {};
    const total = stats.total || mapSummary.total || 0;
    const processed = stats.processed || 0;
    const percent = total ? Math.min(100, Math.round((processed / total) * 100)) : 0;
    return { total, processed, percent };
  }, [job.stats, mapSummary.total]);

  const startRunTokenMap = useCallback(() => {
    setRunMapActive(true);
    setRunTokenSeq(0);
    setRunId(0);
    setRunTokenStates(new Map());
    setTokenUpdatedAt(null);
  }, []);

  const stopRunTokenMap = useCallback(() => {
    setRunMapActive(false);
    setRunTokenSeq(0);
    setRunId(0);
    setRunTokenStates(new Map());
  }, []);

  const loadTokenUpdates = useCallback(async () => {
    const data = await keeperApi.getTokenUpdates(runTokenSeqRef.current);
    if (runIdRef.current && data.run_id && data.run_id !== runIdRef.current) {
      setRunTokenStates(new Map());
      setRunTokenSeq(0);
      runTokenSeqRef.current = 0;
    }
    setRunId(data.run_id || runIdRef.current);
    setRunTokenSeq(data.seq ?? runTokenSeqRef.current);
    if (!data.updates?.length) return;
    setRunTokenStates((prev) => {
      const next = new Map(prev);
      data.updates.forEach((event) => {
        const name = String(event.token?.name || event.name || '');
        if (!name) return;
        const base = tokensRef.current.find((token) => tokenName(token) === name) || ({ name } as KeeperToken);
        next.set(name, { ...base, ...event.token, name });
      });
      return next;
    });
  }, []);

  const pollRuntime = useCallback(async () => {
    if (!authorized) return;
    try {
      const nextJob = await loadJob();
      const running = Boolean(nextJob.running);
      const tokenDue = Date.now() - lastTokenPollRef.current > IDLE_TOKEN_POLL_MS;
      if (running) {
        if (!runMapActiveRef.current) startRunTokenMap();
        await loadTokenUpdates();
      } else if (wasRunningRef.current) {
        await loadTokenUpdates();
        stopRunTokenMap();
        const freshTokens = await loadTokens(false);
        await loadDeletedTokens();
        const afterSummary = inventory(freshTokens);
        const changed = changedTokenNames(baselineHealthMapRef.current, freshTokens);
        const delta = buildTokenDelta(baselineSummaryRef.current, afterSummary);
        setLastChangedTokens(new Set(changed));
        setLastTokenDelta(delta);
        writeJson('keeperLastChangedTokens', changed);
        writeJson('keeperLastTokenDelta', delta);
        baselineSummaryRef.current = afterSummary;
        baselineHealthMapRef.current = buildHealthMap(freshTokens);
      } else if (tokenDue) {
        await loadTokens(false);
      }
      wasRunningRef.current = running;
    } catch (nextError) {
      if (!handleAuthFailure(nextError)) setError(formatError(nextError));
    }
  }, [
    authorized,
    handleAuthFailure,
    loadDeletedTokens,
    loadJob,
    loadTokenUpdates,
    loadTokens,
    startRunTokenMap,
    stopRunTokenMap,
  ]);

  useEffect(() => {
    if (!authorized) return;
    const timer = window.setInterval(() => {
      void pollRuntime();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [authorized, pollRuntime]);

  const savePassword = useCallback(async () => {
    const nextPassword = passwordInput.trim();
    keeperApi.setPassword(nextPassword);
    setAuthError('');
    try {
      await keeperApi.getSettings();
      setAuthorized(true);
      setError('');
    } catch (nextError) {
      keeperApi.setPassword('');
      setAuthorized(false);
      setAuthError(formatError(nextError));
    }
  }, [passwordInput]);

  const clearPassword = useCallback(() => {
    keeperApi.setPassword('');
    setPasswordInput('');
    setAuthorized(false);
    setAuthError('');
  }, []);

  const selectToken = useCallback((name: string) => {
    setSelectedTokens((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const runSelectedAction = useCallback(
    async (
      label: string,
      action: (names: string[]) => Promise<KeeperActionResult>,
      successField: 'updated' | 'deleted',
      confirmText?: string
    ) => {
      const names = Array.from(selectedTokens);
      if (!names.length) return;
      if (confirmText && !window.confirm(confirmText.replace('{count}', String(names.length)))) return;
      setBusyAction(label);
      setError('');
      try {
        const result = await action(names);
        const failed = new Set(result.failed || []);
        setSelectedTokens(failed);
        await Promise.all([loadTokens(false), loadDeletedTokens()]);
        if (failed.size) {
          setError(`${label}完成：成功 ${result[successField]?.length || 0} 个，失败 ${failed.size} 个。`);
        }
      } catch (nextError) {
        if (!handleAuthFailure(nextError)) setError(formatError(nextError));
      } finally {
        setBusyAction('');
      }
    },
    [handleAuthFailure, loadDeletedTokens, loadTokens, selectedTokens]
  );

  const startRun = useCallback(
    async (dryRun: boolean) => {
      baselineSummaryRef.current = inventory(tokensRef.current);
      baselineHealthMapRef.current = buildHealthMap(tokensRef.current);
      startRunTokenMap();
      setError('');
      try {
        const runOptions: KeeperRunOptions = { policy, overrides };
        await keeperApi.run(dryRun, runOptions);
        const nextJob = await loadJob();
        wasRunningRef.current = Boolean(nextJob.running);
      } catch (nextError) {
        stopRunTokenMap();
        if (!handleAuthFailure(nextError)) setError(formatError(nextError));
      }
    },
    [handleAuthFailure, loadJob, overrides, policy, startRunTokenMap, stopRunTokenMap]
  );

  const stopRun = useCallback(async () => {
    setBusyAction('stop');
    try {
      await keeperApi.stop();
      await loadJob();
    } catch (nextError) {
      if (!handleAuthFailure(nextError)) setError(formatError(nextError));
    } finally {
      setBusyAction('');
    }
  }, [handleAuthFailure, loadJob]);

  const setTokenDisabled = useCallback(
    async (name: string, disabled: boolean) => {
      setBusyAction(`status:${name}`);
      try {
        await keeperApi.setTokenDisabled(name, disabled);
        await loadTokens(false);
      } catch (nextError) {
        if (!handleAuthFailure(nextError)) setError(formatError(nextError));
      } finally {
        setBusyAction('');
      }
    },
    [handleAuthFailure, loadTokens]
  );

  const restoreDeletedToken = useCallback(
    async (name: string) => {
      setBusyAction(`restore:${name}`);
      try {
        await keeperApi.restoreDeletedTokens([name]);
        await Promise.all([loadTokens(false), loadDeletedTokens()]);
      } catch (nextError) {
        if (!handleAuthFailure(nextError)) setError(formatError(nextError));
      } finally {
        setBusyAction('');
      }
    },
    [handleAuthFailure, loadDeletedTokens, loadTokens]
  );

  const checkDeletedToken = useCallback(
    async (name: string) => {
      setBusyAction(`check:${name}`);
      try {
        await keeperApi.checkDeletedTokens([name]);
        await loadDeletedTokens();
      } catch (nextError) {
        if (!handleAuthFailure(nextError)) setError(formatError(nextError));
      } finally {
        setBusyAction('');
      }
    },
    [handleAuthFailure, loadDeletedTokens]
  );

  const deleteDeletedToken = useCallback(
    async (name: string) => {
      if (!window.confirm('确认要从已删除库里彻底删除这个 token 吗？')) return;
      setBusyAction(`purge:${name}`);
      try {
        await keeperApi.deleteDeletedTokens([name]);
        await loadDeletedTokens();
      } catch (nextError) {
        if (!handleAuthFailure(nextError)) setError(formatError(nextError));
      } finally {
        setBusyAction('');
      }
    },
    [handleAuthFailure, loadDeletedTokens]
  );

  const pollMonitorOnce = useCallback(async () => {
    setBusyAction('monitor');
    try {
      await keeperApi.pollMonitorOnce();
      await loadMonitorStatus();
    } catch (nextError) {
      if (!handleAuthFailure(nextError)) setError(formatError(nextError));
    } finally {
      setBusyAction('');
    }
  }, [handleAuthFailure, loadMonitorStatus]);

  const policySelect = (key: keyof Required<KeeperRunPolicy>) => (
    <div className={styles.policyField} key={key}>
      <label>{policyLabels[key].title}</label>
      <select
        className={styles.select}
        value={policy[key]}
        onChange={(event) => setPolicy((prev) => ({ ...prev, [key]: event.target.value }))}
      >
        {policyOptions[key].map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <p>{policyLabels[key].hint}</p>
    </div>
  );

  const selectedCount = selectedTokens.size;
  const running = Boolean(job.running);
  const actionDisabled = selectedCount === 0 || Boolean(busyAction) || running;
  const logLines = job.logs || [];
  const totalLogLines = job.log_total ?? logLines.length;

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.pageTitle}>{t('codex_keeper.title', { defaultValue: 'Codex Keeper' })}</h1>
          <p className={styles.subtitle}>
            Management Center 原生 CodexKeeper 控制台：巡检、批量维护、删除库和 sidecar 监控统一在这里管理。
          </p>
        </div>
        <div className={styles.headerActions}>
          <Button variant="secondary" size="sm" onClick={() => void refreshAll(false)} loading={loading} disabled={!authorized}>
            刷新
          </Button>
          <Button variant="secondary" size="sm" onClick={() => void refreshAll(true)} disabled={!authorized || loading}>
            实时读取 CPA
          </Button>
          <Button variant="ghost" size="sm" onClick={clearPassword}>
            重设密码
          </Button>
        </div>
      </div>

      {!authorized && (
        <div className={styles.loginCard}>
          <div>
            <h2>输入 Keeper 管理密码</h2>
            <p>密码只保存在当前浏览器，用来请求 `/keeper-api/`。</p>
          </div>
          <div className={styles.loginControls}>
            <input
              className={styles.input}
              type="password"
              value={passwordInput}
              placeholder="Keeper Web Password"
              autoComplete="current-password"
              onChange={(event) => setPasswordInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void savePassword();
              }}
            />
            <Button onClick={() => void savePassword()} disabled={!passwordInput.trim()}>
              进入控制台
            </Button>
          </div>
          {authError && <div className={styles.errorBox}>{authError}</div>}
        </div>
      )}

      {authorized && (
        <>
          {error && <div className={styles.errorBox}>{error}</div>}

          <div className={styles.statsGrid}>
            <div className={styles.statCard}>
              <span>Token 总数</span>
              <b>{tokenSummary.total}</b>
              <small>{tokenSummary.enabled} 启用 · {tokenSummary.disabled} 禁用</small>
            </div>
            <div className={styles.statCard}>
              <span>存活</span>
              <b>{tokenSummary.alive}</b>
              <small>{tokenSummary.expired} 过期/死号</small>
            </div>
            <div className={styles.statCard}>
              <span>无 Refresh</span>
              <b>{tokenSummary.noRefresh}</b>
              <small>{tokenSummary.noquota} 无额度 · {tokenSummary.unknown} 未知</small>
            </div>
            <div className={styles.statCard}>
              <span>需关注</span>
              <b>{tokenSummary.expired + tokenSummary.noquota + tokenSummary.unknown}</b>
              <small>{tokenSummary.expired} 死号 · {tokenSummary.noquota} 空额度 · {tokenSummary.unknown} 未知</small>
            </div>
          </div>

          <div className={styles.mainGrid}>
            <section className={`${styles.card} ${styles.mapCard}`}>
              <div className={styles.sectionHead}>
                <div>
                  <h2>凭证健康矩阵</h2>
                  <p>
                    {runMapActive
                      ? `${mapSummary.total} 个 token · 本轮已返回 ${runTokenStates.size} 个 · 未返回 ${Math.max(0, mapSummary.total - runTokenStates.size)} 个`
                      : `${mapSummary.total} 个 token · ${mapSummary.enabled} 启用 · ${mapSummary.disabled} 禁用 · ${mapSummary.noRefresh} 无 Refresh`}
                  </p>
                </div>
                <span className={styles.stamp}>{runMapActive ? '巡检实时更新中' : cacheTimeText(tokenUpdatedAt)}</span>
              </div>

              <div className={styles.legend}>
                <span><i className={styles.healthGood} />健康 {mapSummary.good}</span>
                <span><i className={styles.healthWarn} />良好 {mapSummary.warn}</span>
                <span><i className={styles.healthNoquota} />无额度 {mapSummary.noquota}</span>
                <span><i className={styles.healthExpired} />过期 {mapSummary.expired}</span>
                <span><i className={styles.healthUnknown} />未知 {mapSummary.unknown}</span>
              </div>

              <div className={styles.tokenMap}>
                {displayMapTokens.map((token) => {
                  const name = tokenName(token);
                  const health = tokenHealth(token);
                  const selected = selectedTokens.has(name);
                  const changed = changedForMap.has(name);
                  return (
                    <button
                      key={name}
                      type="button"
                      className={[
                        styles.tokenCell,
                        health.className,
                        selected ? styles.tokenCellSelected : '',
                        changed ? styles.tokenCellChanged : '',
                      ].filter(Boolean).join(' ')}
                      title={[
                        `邮箱: ${token.email || '-'}`,
                        `额度: ${usageText(token)}`,
                        `有效期: ${token.remaining || token.expiry || 'unknown'}`,
                        selected ? '已选中，点击取消' : '点击选中，可多选操作',
                      ].join('\n')}
                      aria-label={`${health.label}: ${token.email || name}`}
                      onClick={() => selectToken(name)}
                    />
                  );
                })}
              </div>

              {selectedCount > 0 && (
                <div className={styles.batchBar}>
                  <div>
                    <b>{selectedCount}</b>
                    <span>个 token 已选择</span>
                  </div>
                  <div className={styles.batchActions}>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={actionDisabled}
                      loading={busyAction === '刷新额度'}
                      onClick={() =>
                        void runSelectedAction('刷新额度', (names) => keeperApi.refreshTokenUsage(names), 'updated')
                      }
                    >
                      刷新额度
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={actionDisabled}
                      loading={busyAction === 'Refresh'}
                      onClick={() => void runSelectedAction('Refresh', (names) => keeperApi.refreshTokens(names), 'updated')}
                    >
                      Refresh
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      disabled={actionDisabled}
                      loading={busyAction === '删除'}
                      onClick={() =>
                        void runSelectedAction('删除', (names) => keeperApi.deleteTokens(names), 'deleted', '确认删除已选择的 {count} 个 token 吗？')
                      }
                    >
                      删除
                    </Button>
                    <Button variant="secondary" size="sm" disabled={Boolean(busyAction)} onClick={() => setSelectedTokens(new Set())}>
                      取消选择
                    </Button>
                  </div>
                </div>
              )}

              <div className={styles.deltaRow}>
                {lastTokenDelta ? (
                  <>
                    <span>较上次 {new Date(lastTokenDelta.at).toLocaleTimeString('zh-CN', { hour12: false })}</span>
                    {([
                      ['总数', 'total'],
                      ['启用', 'enabled'],
                      ['过期/死号', 'expired'],
                      ['无额度', 'noquota'],
                      ['未知', 'unknown'],
                      ['无 Refresh', 'noRefresh'],
                    ] as Array<[string, SummaryKey]>).map(([label, key]) => (
                      <span key={key} className={deltaToneClassName(key, lastTokenDelta.diff[key])}>
                        {label}<b>{deltaText(lastTokenDelta.diff[key])}</b>
                      </span>
                    ))}
                  </>
                ) : (
                  <span>完成巡检后显示较上次变化</span>
                )}
              </div>
            </section>

            <section className={`${styles.card} ${styles.runCard}`}>
              <div className={styles.sectionHead}>
                <div>
                  <h2>巡检</h2>
                  <p>按当前策略检查 token，并在需要时禁用、启用、刷新或删除。</p>
                </div>
                <span className={`${styles.statusPulse} ${running ? styles.statusRunning : job.error ? styles.statusError : styles.statusOk}`}>
                  {running ? '↻' : job.error ? '!' : '✓'}
                </span>
              </div>

              <div className={styles.progressBlock}>
                <div>
                  <b>{runProgress.processed} / {runProgress.total}</b>
                  <span>{running ? '巡检正在运行，日志会持续刷新' : '最近一次巡检进度'}</span>
                </div>
                <progress value={runProgress.percent} max={100} aria-label="巡检进度" />
              </div>

              <div className={styles.runActions}>
                <Button size="sm" onClick={() => void startRun(false)} disabled={running || Boolean(busyAction)}>
                  开始巡检
                </Button>
                <Button variant="secondary" size="sm" onClick={() => setPolicyOpen(true)}>
                  巡检参数
                </Button>
                <Button variant="secondary" size="sm" onClick={() => void stopRun()} disabled={!running} loading={busyAction === 'stop'}>
                  终止本轮
                </Button>
              </div>

              <div className={styles.miniGrid}>
                <div><b>{job.stats.processed || 0}</b><span>本轮处理</span></div>
                <div><b>{job.stats.refreshed || 0}</b><span>刷新成功</span></div>
                <div><b>{job.stats.deleted || job.stats.would_delete || 0}</b><span>计划删除</span></div>
                <div><b>{job.stats.disabled || job.stats.would_disable || 0}</b><span>禁用</span></div>
                <div><b>{job.stats.enabled || job.stats.would_enable || 0}</b><span>启用</span></div>
                <div><b>{running ? job.stats.alive || 0 : mapSummary.alive}</b><span>存活</span></div>
              </div>

              <div className={styles.sectionHeadCompact}>
                <div>
                  <h3>运行日志</h3>
                  <p>{logExpanded ? `显示最近 ${LOG_TAIL_LINES} 行` : '默认收起，展开后查看实时输出'}</p>
                </div>
                <div className={styles.logActions}>
                  <span className={styles.stamp}>{totalLogLines > logLines.length ? `${totalLogLines} 行 · 显示 ${logLines.length}` : `${logLines.length} 行`}</span>
                  <Button variant="secondary" size="sm" onClick={() => setLogExpanded((value) => !value)}>
                    {logExpanded ? '收起日志' : '展开日志'}
                  </Button>
                </div>
              </div>
              {logExpanded ? (
                <div className={styles.logBox} ref={logBodyRef}>
                  {logLines.length ? (
                    logLines.map((line, index) => (
                      <div key={`${index}-${line}`} className={`${styles.logLine} ${logClassName(line)}`}>
                        {line || ' '}
                      </div>
                    ))
                  ) : (
                    <div className={`${styles.logLine} ${styles.logInfo}`}>等待巡检输出...</div>
                  )}
                </div>
              ) : (
                <div className={styles.logCollapsed}>
                  运行日志已收起。当前状态：{running ? '巡检进行中' : '空闲'}；最近日志 {logLines.length} 行。
                </div>
              )}
            </section>

            <section className={`${styles.card} ${styles.tableCard}`}>
              <div className={styles.sectionHead}>
                <div>
                  <h2>Token 状态</h2>
                  <p>支持搜索、状态筛选、分页和单个启用/禁用。</p>
                </div>
                <div className={styles.tableTools}>
                  <input
                    className={styles.input}
                    value={tokenQuery}
                    placeholder="搜索邮箱、文件名、账号 ID"
                    onChange={(event) => {
                      setTokenQuery(event.target.value);
                      setTokenPage(1);
                    }}
                  />
                  <select
                    className={styles.select}
                    value={tokenFilter}
                    onChange={(event) => {
                      setTokenFilter(event.target.value as TokenFilter);
                      setTokenPage(1);
                    }}
                  >
                    {(Object.keys(tokenFilterLabels) as TokenFilter[]).map((key) => (
                      <option key={key} value={key}>{tokenFilterLabels[key]}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className={styles.tabs}>
                {(Object.keys(tokenFilterLabels) as TokenFilter[]).map((key) => (
                  <button
                    key={key}
                    type="button"
                    className={tokenFilter === key ? styles.tabActive : ''}
                    onClick={() => {
                      setTokenFilter(key);
                      setTokenPage(1);
                    }}
                  >
                    {tokenFilterLabels[key]}
                  </button>
                ))}
              </div>

              <div className={styles.tableWrap}>
                <table>
                  <thead>
                    <tr>
                      <th>状态</th>
                      <th>邮箱</th>
                      <th>额度</th>
                      <th>有效期</th>
                      <th>Refresh</th>
                      <th>账号 ID</th>
                      <th>文件</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagedTokens.length ? (
                      pagedTokens.map((token) => {
                        const status = tokenStatus(token);
                        const name = tokenName(token);
                        return (
                          <tr key={name}>
                            <td><span className={`${styles.statusBadge} ${toneClassName(status.tone)}`}>{status.text}</span></td>
                            <td>{token.email || '-'}</td>
                            <td className={styles.usageCell}>{usageText(token)}</td>
                            <td>{token.remaining || token.expiry || 'unknown'}</td>
                            <td>{token.has_refresh_token ? '有' : '无'}</td>
                            <td className={styles.mono}>{token.account_id || '-'}</td>
                            <td className={styles.mono}>{name || '-'}</td>
                            <td>
                              <Button
                                variant={token.disabled ? 'secondary' : 'ghost'}
                                size="sm"
                                loading={busyAction === `status:${name}`}
                                onClick={() => void setTokenDisabled(name, !token.disabled)}
                              >
                                {token.disabled ? '启用' : '禁用'}
                              </Button>
                            </td>
                          </tr>
                        );
                      })
                    ) : (
                      <tr><td colSpan={8} className={styles.emptyCell}>没有匹配的 token</td></tr>
                    )}
                  </tbody>
                </table>
              </div>

              <div className={styles.pager}>
                <span>
                  {filteredTokens.length
                    ? `第 ${safeTokenPage} / ${tokenPageCount} 页 · 显示 ${(safeTokenPage - 1) * PAGE_SIZE + 1}-${Math.min(safeTokenPage * PAGE_SIZE, filteredTokens.length)}，共 ${filteredTokens.length} 个`
                    : '没有匹配的 token'}
                </span>
                <div>
                  <Button variant="secondary" size="sm" disabled={safeTokenPage <= 1} onClick={() => setTokenPage((page) => Math.max(1, page - 1))}>
                    上一页
                  </Button>
                  <Button variant="secondary" size="sm" disabled={safeTokenPage >= tokenPageCount} onClick={() => setTokenPage((page) => page + 1)}>
                    下一页
                  </Button>
                </div>
              </div>
            </section>

            <section className={`${styles.card} ${styles.tableCard}`}>
              <div className={styles.sectionHead}>
                <div>
                  <h2>已删除凭证</h2>
                  <p>{filteredDeletedTokens.length ? `${filteredDeletedTokens.length} 个已删除 token，可验证可用性后恢复或彻底删除。` : '没有已删除 token'}</p>
                </div>
                <input
                  className={styles.input}
                  value={deletedQuery}
                  placeholder="搜索邮箱、文件名、账号 ID"
                  onChange={(event) => {
                    setDeletedQuery(event.target.value);
                    setDeletedPage(1);
                  }}
                />
              </div>

              <div className={styles.tableWrap}>
                <table>
                  <thead>
                    <tr>
                      <th>状态</th>
                      <th>邮箱</th>
                      <th>有效期</th>
                      <th>Refresh</th>
                      <th>账号 ID</th>
                      <th>文件</th>
                      <th>可用性</th>
                      <th>删除时间</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagedDeletedTokens.length ? (
                      pagedDeletedTokens.map((token) => {
                        const status = tokenStatus(token);
                        const available = availabilityStatus(token);
                        const name = tokenName(token);
                        return (
                          <tr key={name}>
                            <td><span className={`${styles.statusBadge} ${toneClassName(status.tone)}`}>{status.text}</span></td>
                            <td>{token.email || '-'}</td>
                            <td>{token.remaining || token.expiry || 'unknown'}</td>
                            <td>{token.has_refresh_token ? '有' : '无'}</td>
                            <td className={styles.mono}>{token.account_id || '-'}</td>
                            <td className={styles.mono}>{name || '-'}</td>
                            <td>
                              <span className={`${styles.statusBadge} ${toneClassName(available.tone)}`}>{available.text}</span>
                              <small>{token.availability_checked_at ? formatDateTime(token.availability_checked_at) : '尚未验证'}</small>
                              <small>{token.availability_reason || '-'}</small>
                            </td>
                            <td>{formatDateTime(token.deleted_at)}</td>
                            <td>
                              <div className={styles.rowActions}>
                                <Button variant="secondary" size="sm" loading={busyAction === `check:${name}`} onClick={() => void checkDeletedToken(name)}>
                                  验证可用
                                </Button>
                                <Button variant="secondary" size="sm" loading={busyAction === `restore:${name}`} onClick={() => void restoreDeletedToken(name)}>
                                  恢复
                                </Button>
                                <Button variant="danger" size="sm" loading={busyAction === `purge:${name}`} onClick={() => void deleteDeletedToken(name)}>
                                  彻底删除
                                </Button>
                              </div>
                            </td>
                          </tr>
                        );
                      })
                    ) : (
                      <tr><td colSpan={9} className={styles.emptyCell}>没有已删除 token</td></tr>
                    )}
                  </tbody>
                </table>
              </div>

              <div className={styles.pager}>
                <span>
                  {filteredDeletedTokens.length
                    ? `第 ${safeDeletedPage} / ${deletedPageCount} 页 · 显示 ${(safeDeletedPage - 1) * PAGE_SIZE + 1}-${Math.min(safeDeletedPage * PAGE_SIZE, filteredDeletedTokens.length)}，共 ${filteredDeletedTokens.length} 个 · ${cacheTimeText(deletedUpdatedAt)}`
                    : '没有已删除 token'}
                </span>
                <div>
                  <Button variant="secondary" size="sm" disabled={safeDeletedPage <= 1} onClick={() => setDeletedPage((page) => Math.max(1, page - 1))}>
                    上一页
                  </Button>
                  <Button variant="secondary" size="sm" disabled={safeDeletedPage >= deletedPageCount} onClick={() => setDeletedPage((page) => page + 1)}>
                    下一页
                  </Button>
                </div>
              </div>
            </section>

            <section className={`${styles.card} ${styles.monitorCard}`}>
              <div className={styles.sectionHead}>
                <div>
                  <h2>监控数据持久化状态</h2>
                  <p>
                    这里显示 CodexKeeper 后台 sidecar 是否正在把 CPA 的请求统计写入 NAS 上的 SQLite。
                    它不处理 token 巡检，只负责让监控中心的历史用量不因 CPA 重启或升级丢失。
                  </p>
                </div>
                <Button variant="secondary" size="sm" onClick={() => void pollMonitorOnce()} loading={busyAction === 'monitor'}>
                  立即同步
                </Button>
              </div>
              <div className={styles.monitorGrid}>
                <div><span>持久化状态</span><b>{monitorStatus?.enabled ? '已启用' : '未启用'}</b></div>
                <div><span>已保存事件</span><b>{monitorStatus?.stored_events ?? 0}</b></div>
                <div><span>自动同步间隔</span><b>{monitorStatus ? `${monitorStatus.poll_seconds}s` : '-'}</b></div>
                <div><span>每批读取上限</span><b>{monitorStatus?.batch_size ?? '-'}</b></div>
              </div>
              <div className={styles.monitorMeta}>
                <span>SQLite 文件：{monitorStatus?.db_path || settings?.monitor_db || '-'}</span>
                <span>最近同步：{monitorStatus?.last_poll?.at ? formatDateTime(monitorStatus.last_poll.at) : '-'}</span>
                <span>数据来源：优先消费 CPA usage queue，兼容旧 snapshot 导入。</span>
                {monitorStatus?.last_poll?.error && <span className={styles.metaError}>错误：{monitorStatus.last_poll.error}</span>}
              </div>
            </section>
          </div>
        </>
      )}

      <Modal
        open={policyOpen}
        title="巡检参数设置"
        width={860}
        onClose={() => setPolicyOpen(false)}
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => {
              setPolicy(defaultPolicy);
              setOverrides(defaultOverrides);
            }}>
              恢复默认
            </Button>
            <Button size="sm" onClick={() => setPolicyOpen(false)}>保存</Button>
          </>
        }
      >
        <div className={styles.policyGrid}>
          {policySelect('invalid_token')}
          {policySelect('expired_no_refresh')}
          {policySelect('quota_no_refresh')}
          {policySelect('quota_reached')}
          {policySelect('recovered_disabled')}
          {policySelect('near_expiry')}
          <div className={styles.policyField}>
            <label>额度阈值 %</label>
            <input
              className={styles.input}
              type="number"
              min={0}
              max={100}
              value={overrides.quota_threshold}
              onChange={(event) => setOverrides((prev) => ({ ...prev, quota_threshold: Number(event.target.value || 0) }))}
            />
          </div>
          <div className={styles.policyField}>
            <label>过期阈值 天</label>
            <input
              className={styles.input}
              type="number"
              min={0}
              value={overrides.expiry_threshold_days}
              onChange={(event) => setOverrides((prev) => ({ ...prev, expiry_threshold_days: Number(event.target.value || 0) }))}
            />
          </div>
          <div className={styles.policyField}>
            <label>并发线程</label>
            <input
              className={styles.input}
              type="number"
              min={1}
              max={64}
              value={overrides.worker_threads}
              onChange={(event) => setOverrides((prev) => ({ ...prev, worker_threads: Number(event.target.value || 1) }))}
            />
          </div>
          <div className={`${styles.policyField} ${styles.policySwitch}`}>
            <ToggleSwitch
              checked={overrides.enable_refresh}
              onChange={(value) => setOverrides((prev) => ({ ...prev, enable_refresh: value }))}
              label="允许 Keeper 使用 refresh_token 刷新快过期 token"
            />
          </div>
        </div>
      </Modal>
    </div>
  );
}

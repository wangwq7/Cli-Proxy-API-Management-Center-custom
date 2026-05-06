import axios, { AxiosError, AxiosInstance, AxiosRequestConfig } from 'axios';

const KEEPER_PASSWORD_KEY = 'keeperPassword';

export interface KeeperToken {
  name: string;
  email?: string;
  disabled?: boolean;
  expiry?: string;
  remaining?: string;
  remaining_seconds?: number | null;
  has_refresh_token?: boolean;
  account_id?: string;
  keeper_status?: string;
  keeper_reason?: string;
  last_check_error?: string;
  deleted?: boolean;
  deleted_at?: number;
  deleted_reason?: string;
  availability_status?: string;
  availability_reason?: string;
  usage?: {
    primary_used_percent?: number;
    secondary_used_percent?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface KeeperJob {
  running: boolean;
  mode: string;
  started_at?: number | null;
  finished_at?: number | null;
  error?: string | null;
  stop_requested?: boolean;
  logs: string[];
  log_total: number;
  log_version: number;
  stats: Record<string, number>;
}

export interface KeeperMonitorStatus {
  enabled: boolean;
  db_path: string;
  stored_events: number;
  oldest_timestamp_ms?: number | null;
  newest_timestamp_ms?: number | null;
  poll_seconds: number;
  batch_size: number;
  snapshot_seconds: number;
  retention_days: number;
  last_poll?: {
    at?: number;
    mode?: string;
    error?: string;
    added?: number;
    skipped?: number;
    total?: number;
  };
}

export interface KeeperSettings {
  cpa_endpoint: string;
  cpa_token: string;
  monitor_enabled?: boolean;
  monitor_db?: string;
  monitor_poll_seconds?: number;
  monitor_batch_size?: number;
  monitor_snapshot_seconds?: number;
  monitor_retention_days?: number;
  [key: string]: unknown;
}

export interface KeeperActionResult {
  ok?: boolean;
  updated?: string[];
  deleted?: string[];
  restored?: string[];
  failed?: string[];
  errors?: Record<string, string>;
  [key: string]: unknown;
}

const getKeeperApiBase = (): string => {
  const configured = import.meta.env.VITE_KEEPER_API_BASE;
  if (typeof configured === 'string' && configured.trim()) {
    return configured.trim().replace(/\/+$/, '');
  }
  return '/keeper-api';
};

const getKeeperPassword = () => {
  try {
    return localStorage.getItem(KEEPER_PASSWORD_KEY) || '';
  } catch {
    return '';
  }
};

const setKeeperPassword = (value: string) => {
  try {
    if (value) {
      localStorage.setItem(KEEPER_PASSWORD_KEY, value);
    } else {
      localStorage.removeItem(KEEPER_PASSWORD_KEY);
    }
  } catch {
    // Ignore storage errors.
  }
};

class KeeperApiClient {
  private instance: AxiosInstance;

  constructor() {
    this.instance = axios.create({
      baseURL: getKeeperApiBase(),
      timeout: 60_000,
      headers: {
        'Content-Type': 'application/json'
      }
    });

    this.instance.interceptors.request.use((config) => {
      const password = getKeeperPassword();
      if (password) {
        config.headers['X-Keeper-Password'] = password;
      }
      return config;
    });

    this.instance.interceptors.response.use(
      (response) => response,
      (error: AxiosError) => {
        const message =
          typeof error.response?.data === 'object' &&
          error.response?.data &&
          'error' in error.response.data
            ? String((error.response.data as { error?: unknown }).error || error.message)
            : error.message;
        const err = new Error(message || 'Keeper request failed') as Error & {
          status?: number;
          code?: string;
          data?: unknown;
        };
        err.status = error.response?.status;
        err.code = error.code;
        err.data = error.response?.data;
        if (error.response?.status === 401) {
          window.dispatchEvent(new Event('keeper-unauthorized'));
        }
        return Promise.reject(err);
      }
    );
  }

  setPassword(value: string): void {
    setKeeperPassword(value.trim());
  }

  getPassword(): string {
    return getKeeperPassword();
  }

  async get<T = unknown>(url: string, config?: AxiosRequestConfig): Promise<T> {
    const response = await this.instance.get<T>(url, config);
    return response.data;
  }

  async post<T = unknown>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T> {
    const response = await this.instance.post<T>(url, data, config);
    return response.data;
  }

  health() {
    return this.get<{ ok: boolean; service: string }>('/health');
  }

  getJob(tail = 220) {
    return this.get<KeeperJob>('/job', { params: { tail } });
  }

  getSettings() {
    return this.get<KeeperSettings>('/settings');
  }

  listTokens(live = false) {
    return this.get<{ tokens: KeeperToken[]; cached: boolean; updated_at?: number | null }>(
      '/tokens',
      { params: live ? { live: 1 } : undefined }
    );
  }

  listDeletedTokens() {
    return this.get<{ tokens: KeeperToken[]; updated_at?: number | null }>('/deleted-tokens');
  }

  run(dryRun: boolean) {
    return this.post<{ ok: boolean }>('/run', { dry_run: dryRun });
  }

  stop() {
    return this.post<{ ok: boolean }>('/stop', {});
  }

  setTokenDisabled(name: string, disabled: boolean) {
    return this.post<{ ok: boolean }>('/token/status', { name, disabled });
  }

  refreshTokenUsage(names: string[]) {
    return this.post<KeeperActionResult>('/tokens/refresh-usage', { names });
  }

  refreshTokens(names: string[]) {
    return this.post<KeeperActionResult>('/tokens/refresh', { names });
  }

  deleteTokens(names: string[]) {
    return this.post<KeeperActionResult>('/tokens/delete', { names });
  }

  restoreDeletedTokens(names: string[]) {
    return this.post<KeeperActionResult>('/deleted-tokens/restore', { names });
  }

  checkDeletedTokens(names: string[]) {
    return this.post<KeeperActionResult>('/deleted-tokens/check', { names });
  }

  deleteDeletedTokens(names: string[]) {
    return this.post<KeeperActionResult>('/deleted-tokens/delete', { names });
  }

  getMonitorStatus() {
    return this.get<KeeperMonitorStatus>('/monitor/status');
  }

  pollMonitorOnce() {
    return this.post<KeeperActionResult>('/monitor/poll', {});
  }

  getMonitorUsage(config?: AxiosRequestConfig) {
    return this.get<Record<string, unknown>>('/monitor/usage', config);
  }

  exportMonitorUsage() {
    return this.get<Record<string, unknown>>('/monitor/usage/export');
  }

  importMonitorUsage(payload: unknown) {
    return this.post<Record<string, unknown>>('/monitor/usage/import', payload);
  }
}

export const keeperApi = new KeeperApiClient();


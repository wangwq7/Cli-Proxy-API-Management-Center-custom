/**
 * 使用统计相关 API
 */

import { apiClient } from './client';
import { keeperApi } from './keeper';
import { computeKeyStats, KeyStats } from '@/utils/usage';

const USAGE_TIMEOUT_MS = 60 * 1000;

export interface UsageExportPayload {
  version?: number;
  exported_at?: string;
  usage?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface UsageImportResponse {
  added?: number;
  skipped?: number;
  total_requests?: number;
  failed_requests?: number;
  [key: string]: unknown;
}

export const usageApi = {
  /**
   * 获取使用统计原始数据。优先读 CodexKeeper sidecar 的持久化库；
   * 旧部署没有 sidecar 时回退到 CPA 自带 /usage。
   */
  async getUsage() {
    try {
      return await keeperApi.getMonitorUsage({ timeout: USAGE_TIMEOUT_MS });
    } catch (error: unknown) {
      const status = (error as { status?: number } | null)?.status;
      if (status === 401) {
        throw error;
      }
      return apiClient.get<Record<string, unknown>>('/usage', { timeout: USAGE_TIMEOUT_MS });
    }
  },

  /**
   * 导出使用统计快照
   */
  async exportUsage() {
    try {
      return (await keeperApi.exportMonitorUsage()) as UsageExportPayload;
    } catch (error: unknown) {
      const status = (error as { status?: number } | null)?.status;
      if (status === 401) {
        throw error;
      }
      return apiClient.get<UsageExportPayload>('/usage/export', { timeout: USAGE_TIMEOUT_MS });
    }
  },

  /**
   * 导入使用统计快照
   */
  async importUsage(payload: unknown) {
    try {
      return (await keeperApi.importMonitorUsage(payload)) as UsageImportResponse;
    } catch (error: unknown) {
      const status = (error as { status?: number } | null)?.status;
      if (status === 401) {
        throw error;
      }
      return apiClient.post<UsageImportResponse>('/usage/import', payload, { timeout: USAGE_TIMEOUT_MS });
    }
  },

  /**
   * 计算密钥成功/失败统计，必要时会先获取 usage 数据
   */
  async getKeyStats(usageData?: unknown): Promise<KeyStats> {
    let payload = usageData;
    if (!payload) {
      const response = await usageApi.getUsage();
      payload = response?.usage ?? response;
    }
    return computeKeyStats(payload);
  }
};

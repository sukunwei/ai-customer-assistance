import { useState, useEffect, useCallback } from 'react';
import { ProviderId, ProviderInfo } from '../types';

const STORAGE_KEY = 'agentProvider';

/**
 * Provider 选择状态
 *
 * provider: 用户在前端显式选择的 provider；为空表示「跟随服务端默认」（AGENT_PROVIDER）
 * effectiveProvider: 实际生效的 provider
 */
export function useProvider() {
  const [provider, setProviderState] = useState<ProviderId | ''>(() => {
    return (localStorage.getItem(STORAGE_KEY) as ProviderId | null) || '';
  });
  const [serverProvider, setServerProvider] = useState<ProviderId>('claude');
  const [providers, setProviders] = useState<ProviderInfo[]>([]);

  const fetchProviders = useCallback(async () => {
    try {
      const res = await fetch('/api/providers');
      const data = await res.json();
      setProviders(data.providers || []);
      setServerProvider(data.activeProvider || 'claude');
    } catch (error) {
      console.error('Failed to fetch providers:', error);
    }
  }, []);

  useEffect(() => {
    fetchProviders();
  }, [fetchProviders]);

  const setProvider = useCallback((next: ProviderId | '') => {
    setProviderState(next);
    if (next) {
      localStorage.setItem(STORAGE_KEY, next);
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  }, []);

  const effectiveProvider: ProviderId = provider || serverProvider;

  return {
    provider,
    effectiveProvider,
    setProvider,
    serverProvider,
    providers,
    fetchProviders,
  };
}

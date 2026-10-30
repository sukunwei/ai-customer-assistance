import { useState, useEffect, useCallback } from 'react';
import { Model, ProviderId } from '../types';

const STORAGE_KEY = 'defaultModel';

export function useModels(provider: ProviderId = 'claude') {
  const [models, setModels] = useState<Model[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>(() => {
    return localStorage.getItem(STORAGE_KEY) || '';
  });

  const fetchModels = useCallback(async () => {
    try {
      const res = await fetch(`/api/models?provider=${provider}`);
      const data = await res.json();
      const available: Model[] = data.models || [];
      setModels(available);

      // 当前选中的模型可能不属于新的 provider，需要回退到该 provider 的默认模型
      setSelectedModel(prev => {
        const saved = localStorage.getItem(STORAGE_KEY);
        const isAvailable = (modelId: string) => available.some(m => m.modelId === modelId);
        const candidates = [prev, saved].filter(Boolean) as string[];
        const next = candidates.find(isAvailable) || data.defaultModel || available[0]?.modelId || '';
        if (next) {
          localStorage.setItem(STORAGE_KEY, next);
        }
        return next || prev;
      });
    } catch (error) {
      console.error('Failed to fetch models:', error);
    }
  }, [provider]);

  // 初始加载 + provider 变化时重新拉取
  useEffect(() => {
    fetchModels();
  }, [fetchModels]);

  return {
    models,
    selectedModel,
    setSelectedModel,
    fetchModels,
  };
}

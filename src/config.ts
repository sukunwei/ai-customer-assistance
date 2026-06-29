/**
 * 应用配置文件 - 智能客服 Agent
 */

export const APP_CONFIG = {
  /** 应用名称 */
  name: '智能客服',

  /** 应用名称首字母（用于 Logo） */
  nameInitial: '客',

  /** 应用描述 */
  description: '您好，我是智能客服小智，请问有什么可以帮您？',

  /** 版本号 */
  version: '1.0.0',

  /** 客服名称 */
  agentName: '小智',
};

/** 意图标签颜色映射 */
export const INTENT_COLORS: Record<string, string> = {
  '退款': '#e34d59',
  '订单查询': '#0052d9',
  '技术支持': '#ed7b2f',
  '转人工': '#e37318',
  '通用': '#2ba471',
};

/** 意图中文名称 */
export const INTENT_LABELS: Record<string, string> = {
  '退款': '退款问题',
  '订单查询': '订单查询',
  '技术支持': '技术支持',
  '转人工': '转人工',
  '通用': '通用咨询',
};

export default APP_CONFIG;

import { useState, useEffect, useCallback } from 'react';
import {
  Card,
  Table,
  Tag,
  Statistic,
  Space,
  MessagePlugin,
  Loading,
} from 'tdesign-react';
import {
  ChatIcon,
  TimeIcon,
  StarIcon,
  UserIcon,
} from 'tdesign-icons-react';
import type { AdminConversation, AdminDashboardStats } from '../types';
import { APP_CONFIG, INTENT_COLORS, INTENT_LABELS } from '../config';

export function AdminPage() {
  const [stats, setStats] = useState<AdminDashboardStats | null>(null);
  const [conversations, setConversations] = useState<AdminConversation[]>([]);
  const [totalConversations, setTotalConversations] = useState(0);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const pageSize = 20;

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const [statsRes, convRes] = await Promise.all([
        fetch('/api/admin/dashboard'),
        fetch(`/api/admin/conversations?limit=${pageSize}&offset=${(page - 1) * pageSize}`),
      ]);

      if (statsRes.ok) {
        setStats(await statsRes.json());
      }
      if (convRes.ok) {
        const data = await convRes.json();
        setConversations(data.conversations || []);
        setTotalConversations(data.total || 0);
      }
    } catch (err) {
      console.error('Failed to fetch admin data:', err);
      MessagePlugin.error('获取管理数据失败');
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const formatTime = (iso: string) => {
    try {
      return new Date(iso).toLocaleString('zh-CN');
    } catch {
      return iso;
    }
  };

  const ratingEmojis: Record<number, string> = {
    1: '😡', 2: '😟', 3: '😐', 4: '😊', 5: '😍',
  };

  const columns = [
    {
      colKey: 'title',
      title: '会话标题',
      width: 200,
      ellipsis: true,
      cell: ({ row }: { row: AdminConversation }) => (
        <span style={{ fontWeight: 500 }}>{row.title || '未命名会话'}</span>
      ),
    },
    {
      colKey: 'message_count',
      title: '消息数',
      width: 80,
      align: 'center' as const,
      cell: ({ row }: { row: AdminConversation }) => (
        <Tag size="small" variant="light" theme="primary">
          {row.message_count} 条
        </Tag>
      ),
    },
    {
      colKey: 'rating_score',
      title: '满意度',
      width: 110,
      align: 'center' as const,
      cell: ({ row }: { row: AdminConversation }) => {
        if (row.rating_score == null) {
          return <Tag size="small" variant="outline" theme="default">未评价</Tag>;
        }
        return (
          <Space size={4}>
            <span>{ratingEmojis[row.rating_score] || '⭐'}</span>
            <span style={{ fontWeight: 600, color: row.rating_score >= 4 ? '#2ba471' : row.rating_score >= 3 ? '#ed7b2f' : '#e34d59' }}>
              {row.rating_score}/5
            </span>
          </Space>
        );
      },
    },
    {
      colKey: 'rating_comment',
      title: '评价内容',
      width: 160,
      ellipsis: true,
      cell: ({ row }: { row: AdminConversation }) => (
        <span style={{ color: 'var(--td-text-color-secondary)', fontSize: '13px' }}>
          {row.rating_comment || '-'}
        </span>
      ),
    },
    {
      colKey: 'updated_at',
      title: '最后更新',
      width: 170,
      cell: ({ row }: { row: AdminConversation }) => (
        <span style={{ fontSize: '13px', color: 'var(--td-text-color-secondary)' }}>
          {formatTime(row.updated_at)}
        </span>
      ),
    },
  ];

  const ratingDistribution = stats?.ratingStats?.distribution || {};

  // 分布图中的最高值
  const maxDistValue = Math.max(...Object.values(ratingDistribution), 1);

  return (
    <div
      className="flex-1 overflow-auto"
      style={{ backgroundColor: 'var(--td-bg-color-page)' }}
    >
      <div className="max-w-6xl mx-auto p-6 space-y-6">
        {/* 页面标题 */}
        <div>
          <h2 className="text-xl font-bold" style={{ color: 'var(--td-text-color-primary)' }}>
            管理后台
          </h2>
          <p className="text-sm mt-1" style={{ color: 'var(--td-text-color-secondary)' }}>
            对话记录与满意度统计 · {APP_CONFIG.name}
          </p>
        </div>

        <Loading loading={loading} text="加载中...">
          {/* 统计卡片 */}
          {stats && (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <Card bordered>
                <Statistic
                  title="总会话数"
                  value={stats.totalConversations}
                  prefix={<ChatIcon size="20px" />}
                />
              </Card>
              <Card bordered>
                <Statistic
                  title="今日会话"
                  value={stats.todayConversations}
                  prefix={<TimeIcon size="20px" />}
                />
              </Card>
              <Card bordered>
                <Statistic
                  title="平均评分"
                  value={stats.ratingStats.total ? stats.ratingStats.avgScore : 0}
                  suffix={
                    stats.ratingStats.total
                      ? `/5 (${stats.ratingStats.total}评)`
                      : '/5 (暂无评分)'
                  }
                  prefix={<StarIcon size="20px" />}
                />
              </Card>
              <Card bordered>
                <Statistic
                  title="平均消息/会话"
                  value={stats.avgMessagesPerSession}
                  prefix={<UserIcon size="20px" />}
                />
              </Card>
            </div>
          )}

          {/* 满意度分布 & 意图分布 */}
          {stats && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* 满意度分布 */}
              <Card title="满意度分布" bordered>
                <div className="space-y-3">
                  {[5, 4, 3, 2, 1].map(score => {
                    const count = ratingDistribution[score] || 0;
                    const pct = maxDistValue > 0 ? (count / maxDistValue) * 100 : 0;
                    return (
                      <div key={score} className="flex items-center gap-3">
                        <span className="text-sm w-12 text-right" style={{ color: 'var(--td-text-color-secondary)' }}>
                          {ratingEmojis[score]}
                        </span>
                        <div className="flex-1 h-6 rounded" style={{ backgroundColor: 'var(--td-bg-color-component)' }}>
                          <div
                            className="h-full rounded transition-all duration-300"
                            style={{
                              width: `${pct}%`,
                              backgroundColor: score >= 4 ? '#2ba471' : score >= 3 ? '#ed7b2f' : '#e34d59',
                              minWidth: count > 0 ? '20px' : '0',
                            }}
                          />
                        </div>
                        <span className="text-sm w-8" style={{ color: 'var(--td-text-color-primary)', fontWeight: 600 }}>
                          {count}
                        </span>
                      </div>
                    );
                  })}
                  {stats.ratingStats.total === 0 && (
                    <p className="text-sm text-center py-4" style={{ color: 'var(--td-text-color-placeholder)' }}>
                      暂无评价数据
                    </p>
                  )}
                </div>
              </Card>

              {/* 意图分布 */}
              <Card title="意图分布" bordered>
                <div className="space-y-3">
                  {stats.intentStats.length > 0 ? (
                    stats.intentStats.map(item => {
                      const maxCount = stats.intentStats[0]?.count || 1;
                      const pct = (item.count / maxCount) * 100;
                      return (
                        <div key={item.intent} className="flex items-center gap-3">
                          <span className="text-sm w-20 text-right">
                            <Tag
                              size="small"
                              variant="light"
                              style={{
                                backgroundColor: (INTENT_COLORS[item.intent] || '#999') + '20',
                                color: INTENT_COLORS[item.intent] || '#999',
                                borderColor: 'transparent',
                              }}
                            >
                              {INTENT_LABELS[item.intent] || item.intent}
                            </Tag>
                          </span>
                          <div className="flex-1 h-6 rounded" style={{ backgroundColor: 'var(--td-bg-color-component)' }}>
                            <div
                              className="h-full rounded transition-all duration-300"
                              style={{
                                width: `${pct}%`,
                                backgroundColor: INTENT_COLORS[item.intent] || '#999',
                                minWidth: '20px',
                              }}
                            />
                          </div>
                          <span className="text-sm w-8" style={{ color: 'var(--td-text-color-primary)', fontWeight: 600 }}>
                            {item.count}
                          </span>
                        </div>
                      );
                    })
                  ) : (
                    <p className="text-sm text-center py-4" style={{ color: 'var(--td-text-color-placeholder)' }}>
                      暂无意图数据
                    </p>
                  )}
                </div>
              </Card>
            </div>
          )}

          {/* 对话记录表 */}
          <Card title="对话记录" bordered>
            <Table
              data={conversations}
              columns={columns}
              rowKey="session_id"
              hover
              stripe
              pagination={{
                current: page,
                pageSize,
                total: totalConversations,
                onChange: (pageInfo) => {
                  setPage(pageInfo.current);
                },
              }}
              empty="暂无对话记录"
            />
          </Card>
        </Loading>
      </div>
    </div>
  );
}

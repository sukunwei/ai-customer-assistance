import { useState } from 'react';
import { Button, Radio, Textarea, MessagePlugin } from 'tdesign-react';
import { ThumbUpIcon, ThumbDownIcon, StarIcon } from 'tdesign-icons-react';
import type { Rating } from '../types';

interface SatisfactionRatingProps {
  sessionId: string;
  existingRating?: Rating | null;
  onRatingSubmit?: (rating: Rating) => void;
}

const RATING_OPTIONS = [
  { value: 5, label: '😍 非常满意', color: '#2ba471' },
  { value: 4, label: '😊 满意', color: '#00a870' },
  { value: 3, label: '😐 一般', color: '#ed7b2f' },
  { value: 2, label: '😟 不满意', color: '#e34d59' },
  { value: 1, label: '😡 非常不满意', color: '#d54941' },
];

export function SatisfactionRating({
  sessionId,
  existingRating,
  onRatingSubmit,
}: SatisfactionRatingProps) {
  const [showForm, setShowForm] = useState(false);
  const [score, setScore] = useState<number>(0);
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(!!existingRating);

  const handleSubmit = async () => {
    if (score === 0) {
      MessagePlugin.warning('请选择满意度评分');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/ratings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          score,
          comment: comment.trim() || undefined,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || '提交失败');
      }

      const data = await res.json();
      setSubmitted(true);
      setShowForm(false);
      MessagePlugin.success('感谢您的评价！');
      onRatingSubmit?.(data.rating);
    } catch (err: any) {
      MessagePlugin.error(err.message || '提交评价失败');
    } finally {
      setSubmitting(false);
    }
  };

  // 已评价状态
  if (submitted || existingRating) {
    const r = existingRating;
    return (
      <div
        className="flex items-center gap-2 px-4 py-2 rounded-lg"
        style={{ backgroundColor: 'var(--td-bg-color-component)' }}
      >
        <StarIcon size="16px" style={{ color: '#ed7b2f' }} />
        <span className="text-sm" style={{ color: 'var(--td-text-color-secondary)' }}>
          已评价 {r?.score ? `${r.score}/5` : ''}
        </span>
        {r?.comment && (
          <span className="text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
            「{r.comment}」
          </span>
        )}
      </div>
    );
  }

  // 评分表单
  if (showForm) {
    return (
      <div
        className="p-4 rounded-lg space-y-3"
        style={{
          backgroundColor: 'var(--td-bg-color-container)',
          border: '1px solid var(--td-border-level-1-color)',
        }}
      >
        <p className="text-sm font-medium" style={{ color: 'var(--td-text-color-primary)' }}>
          请对本次服务进行评价
        </p>
        <div className="flex flex-wrap gap-2">
          {RATING_OPTIONS.map(opt => (
            <Button
              key={opt.value}
              size="small"
              variant={score === opt.value ? 'base' : 'outline'}
              onClick={() => setScore(opt.value)}
              style={{
                borderColor: score === opt.value ? opt.color : undefined,
                color: score === opt.value ? opt.color : undefined,
              }}
            >
              {opt.label}
            </Button>
          ))}
        </div>
        <Textarea
          value={comment}
          onChange={(val) => setComment(val as string)}
          placeholder="欢迎留下更多建议（选填）"
          autosize={{ minRows: 2, maxRows: 4 }}
        />
        <div className="flex gap-2">
          <Button
            size="small"
            theme="primary"
            loading={submitting}
            onClick={handleSubmit}
          >
            提交评价
          </Button>
          <Button
            size="small"
            variant="outline"
            onClick={() => setShowForm(false)}
          >
            取消
          </Button>
        </div>
      </div>
    );
  }

  // 邀请评价按钮
  return (
    <div
      className="flex items-center gap-3 px-4 py-3 rounded-lg cursor-pointer hover:opacity-80 transition-opacity"
      style={{ backgroundColor: 'var(--td-bg-color-component)' }}
      onClick={() => setShowForm(true)}
    >
      <span className="text-sm" style={{ color: 'var(--td-text-color-secondary)' }}>
        本次服务是否解决了您的问题？
      </span>
      <Button size="small" variant="text" icon={<ThumbUpIcon />}>
        满意
      </Button>
      <Button size="small" variant="text" icon={<ThumbDownIcon />}>
        不满意
      </Button>
    </div>
  );
}

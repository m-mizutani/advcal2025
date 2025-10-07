'use client';

import { Article } from '@/types/status';
import {
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  LineChart,
  Line,
} from 'recharts';

interface ProgressChartProps {
  articles: Article[];
}

export default function ProgressChart({ articles }: ProgressChartProps) {
  // バーンダウンチャートのデータ生成
  const generateBurndownData = () => {
    const startDate = new Date('2025-10-07');
    const endDate = new Date('2025-12-25');
    const totalArticles = articles.length;

    const data: Array<{
      date: string;
      displayDate: string;
      planned: number;
      actual: number | null;
    }> = [];

    // 日付ごとのデータポイントを生成（週単位で表示）
    const currentDate = new Date(startDate);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    while (currentDate <= endDate) {
      const dateStr = currentDate.toISOString().split('T')[0];

      // 予定線：締切を過ぎた記事数を引いて「残り記事数」を計算
      const completedByDeadline = articles.filter(a => a.writing_deadline <= dateStr).length;
      const planned = totalArticles - completedByDeadline;

      // 実績線：完了した記事数を引いて「残り記事数」を計算
      let actual: number | null = null;
      if (currentDate <= today) {
        const completedCount = articles.filter(a => {
          if (!a.completed_date) return false;
          return a.completed_date <= dateStr;
        }).length;
        actual = totalArticles - completedCount;
      }

      // 毎日データポイントを追加（グラフは間引いて表示）
      data.push({
        date: dateStr,
        displayDate: `${currentDate.getMonth() + 1}/${currentDate.getDate()}`,
        planned,
        actual,
      });

      // 1日進める
      currentDate.setDate(currentDate.getDate() + 1);
    }

    return data;
  };

  const burndownData = generateBurndownData();

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
      <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-4">
        執筆バーンダウンチャート（2025年10月〜12月）
      </h2>
      <ResponsiveContainer width="100%" height={400}>
        <LineChart data={burndownData}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis
            dataKey="displayDate"
            angle={-45}
            textAnchor="end"
            height={80}
            interval={6}
          />
          <YAxis
            label={{ value: '残り記事数', angle: -90, position: 'insideLeft' }}
            domain={[0, articles.length]}
          />
          <Tooltip
            content={({ active, payload }) => {
              if (active && payload && payload.length) {
                return (
                  <div className="bg-white dark:bg-gray-800 p-3 border border-gray-200 dark:border-gray-700 rounded shadow-lg">
                    <p className="font-semibold">{payload[0].payload.date}</p>
                    <p className="text-sm text-gray-600">予定残り: {payload[0].payload.planned}本</p>
                    {payload[0].payload.actual !== null && (
                      <p className="text-sm text-blue-600">実績残り: {payload[0].payload.actual}本</p>
                    )}
                  </div>
                );
              }
              return null;
            }}
          />
          <Legend />
          <Line
            type="stepAfter"
            dataKey="planned"
            stroke="#9CA3AF"
            strokeWidth={2}
            strokeDasharray="5 5"
            dot={{ r: 3 }}
            name="予定（執筆締切ベース）"
          />
          <Line
            type="stepAfter"
            dataKey="actual"
            stroke="#3B82F6"
            strokeWidth={3}
            dot={{ r: 4 }}
            name="実績（完了日ベース）"
            connectNulls={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

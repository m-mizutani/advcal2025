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
      actualOnTrack: number | null;
      actualOverdue: number | null;
    }> = [];

    // 日付ごとのデータポイントを生成（週単位で表示）
    const currentDate = new Date(startDate);
    // タイムゾーンの問題を避けるため、文字列ベースで今日の日付を取得
    // システム日付を基準にする（サーバー側で生成されるため、YAMLファイルの日付と一貫性がある）
    const now = new Date();
    const jstOffset = 9 * 60; // JST is UTC+9
    const jstDate = new Date(now.getTime() + (jstOffset + now.getTimezoneOffset()) * 60000);
    const todayStr = jstDate.toISOString().split('T')[0];

    console.log('Today (JST):', todayStr);
    console.log('Articles with completed_date:', articles.filter(a => a.completed_date).map(a => ({ slug: a.slug, completed_date: a.completed_date })));

    let previousState: 'onTrack' | 'overdue' | null = null;

    while (currentDate <= endDate) {
      const dateStr = currentDate.toISOString().split('T')[0];

      // 予定線：締切を過ぎた記事数を引いて「残り記事数」を計算
      const completedByDeadline = articles.filter(a => a.writing_deadline <= dateStr).length;
      const planned = totalArticles - completedByDeadline;

      // 実績線：完了した記事数を引いて「残り記事数」を計算（文字列比較で行う）
      let actual: number | null = null;
      let actualOnTrack: number | null = null;
      let actualOverdue: number | null = null;

      if (dateStr <= todayStr) {
        const completedCount = articles.filter(a => {
          if (!a.completed_date) return false;
          return a.completed_date <= dateStr;
        }).length;
        actual = totalArticles - completedCount;

        const currentState = actual > planned ? 'overdue' : 'onTrack';

        // 状態が切り替わる場合、両方の値を設定して線を繋げる
        if (previousState && previousState !== currentState) {
          actualOnTrack = actual;
          actualOverdue = actual;
        } else if (currentState === 'overdue') {
          actualOverdue = actual;
          actualOnTrack = null;
        } else {
          actualOnTrack = actual;
          actualOverdue = null;
        }

        previousState = currentState;
      }

      // 毎日データポイントを追加（グラフは間引いて表示）
      data.push({
        date: dateStr,
        displayDate: `${currentDate.getMonth() + 1}/${currentDate.getDate()}`,
        planned,
        actual,
        actualOnTrack,
        actualOverdue,
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
                      <p className={`text-sm ${payload[0].payload.actual > payload[0].payload.planned ? 'text-red-600' : 'text-blue-600'}`}>
                        実績残り: {payload[0].payload.actual}本
                      </p>
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
            stroke="#D1D5DB"
            strokeWidth={2}
            dot={{ r: 3 }}
            name="予定（執筆締切ベース）"
          />
          <Line
            type="stepAfter"
            dataKey="actualOnTrack"
            stroke="#3B82F6"
            strokeWidth={3}
            dot={{ r: 4 }}
            name="実績（完了日ベース）"
            connectNulls={false}
          />
          <Line
            type="stepAfter"
            dataKey="actualOverdue"
            stroke="#DC2626"
            strokeWidth={3}
            dot={{ r: 4, fill: '#DC2626' }}
            name="実績（遅延）"
            connectNulls={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

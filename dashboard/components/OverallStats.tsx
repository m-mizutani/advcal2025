'use client';

import { Article } from '@/types/status';

interface OverallStatsProps {
  articles: Article[];
}

export default function OverallStats({ articles }: OverallStatsProps) {
  const totalArticles = articles.length;
  const completedArticles = articles.filter(
    (a) => a.status === 'completed' || a.status === 'published'
  ).length;
  const publishedArticles = articles.filter((a) => a.status === 'published').length;
  const inProgressArticles = articles.filter((a) => a.status === 'in_progress').length;

  const averageProgress =
    articles.reduce((sum, article) => sum + article.progress, 0) / totalArticles;

  const today = new Date().toISOString().split('T')[0];
  const overdueArticles = articles.filter(
    (a) => a.writing_deadline < today && a.status !== 'completed' && a.status !== 'published'
  ).length;

  const stats = [
    {
      label: '総記事数',
      value: String(totalArticles),
      color: 'bg-blue-500',
      textColor: 'text-blue-600 dark:text-blue-400',
    },
    {
      label: '公開済み',
      value: String(publishedArticles),
      color: 'bg-purple-500',
      textColor: 'text-purple-600 dark:text-purple-400',
    },
    {
      label: '完了',
      value: String(completedArticles),
      color: 'bg-green-500',
      textColor: 'text-green-600 dark:text-green-400',
    },
    {
      label: '執筆中',
      value: String(inProgressArticles),
      color: 'bg-yellow-500',
      textColor: 'text-yellow-600 dark:text-yellow-400',
    },
    {
      label: '平均進捗率',
      value: `${averageProgress.toFixed(1)}%`,
      color: 'bg-indigo-500',
      textColor: 'text-indigo-600 dark:text-indigo-400',
    },
    {
      label: '締切超過',
      value: String(overdueArticles),
      color: 'bg-red-500',
      textColor: 'text-red-600 dark:text-red-400',
    },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
      {stats.map((stat) => (
        <div
          key={stat.label}
          className="bg-white dark:bg-gray-800 rounded-lg shadow p-6"
        >
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-600 dark:text-gray-400">
                {stat.label}
              </p>
              <p className={`text-2xl font-bold ${stat.textColor} mt-2`}>
                {stat.value}
              </p>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

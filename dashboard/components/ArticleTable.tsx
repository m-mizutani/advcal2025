'use client';

import { Article } from '@/types/status';

interface ArticleTableProps {
  articles: Article[];
}

const statusLabels: Record<Article['status'], string> = {
  not_started: '未着手',
  in_progress: '執筆中',
  review: 'レビュー中',
  completed: '完了',
  published: '公開済み',
};

const statusColors: Record<Article['status'], string> = {
  not_started: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300',
  in_progress: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300',
  review: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-300',
  completed: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300',
  published: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300',
};

export default function ArticleTable({ articles }: ArticleTableProps) {
  // VSCode URIを生成する関数
  const getVSCodeUri = (slug: string) => {
    const articlePath = `/Users/mizutani/.ghq/github.com/m-mizutani/zenn.dev/articles/${slug}.md`;
    return `vscode://file${articlePath}`;
  };

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-white">
          記事一覧
        </h2>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
          <thead className="bg-gray-50 dark:bg-gray-700">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">
                Day
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">
                タイトル
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">
                執筆締切
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">
                公開締切
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">
                投稿予定
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">
                完了日
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">
                進捗
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">
                状態
              </th>
            </tr>
          </thead>
          <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
            {articles.map((article) => (
              <tr key={article.day} className="hover:bg-gray-50 dark:hover:bg-gray-700">
                <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900 dark:text-white">
                  {article.day}
                </td>
                <td className="px-6 py-4 text-sm">
                  <a
                    href={getVSCodeUri(article.slug)}
                    className="text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 hover:underline flex items-center gap-2"
                    title="VSCodeで開く"
                  >
                    <span>{article.title}</span>
                    <svg
                      className="w-4 h-4"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                      />
                    </svg>
                  </a>
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                  {article.writing_deadline}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                  {article.publication_deadline}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                  {article.scheduled_date} {article.scheduled_time}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                  {article.completed_date || '-'}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 dark:text-white">
                  <div className="flex items-center">
                    <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2 mr-2">
                      <div
                        className="bg-blue-600 h-2 rounded-full"
                        style={{ width: `${article.progress}%` }}
                      ></div>
                    </div>
                    <span className="text-sm font-medium">{article.progress}%</span>
                  </div>
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <span
                    className={`px-2 py-1 inline-flex text-xs leading-5 font-semibold rounded-full ${
                      statusColors[article.status]
                    }`}
                  >
                    {statusLabels[article.status]}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

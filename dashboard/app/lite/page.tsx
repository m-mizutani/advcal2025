import { promises as fs } from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { StatusData, Article } from '@/types/status';

async function getStatusData(): Promise<StatusData> {
  const filePath = path.join(process.cwd(), '..', 'status.yml');
  const fileContent = await fs.readFile(filePath, 'utf8');
  const data = yaml.load(fileContent, { schema: yaml.JSON_SCHEMA }) as StatusData;

  // Ensure all dates are strings
  data.start_date = String(data.start_date);
  data.end_date = String(data.end_date);
  data.articles = data.articles.map(article => ({
    ...article,
    scheduled_date: String(article.scheduled_date),
    writing_deadline: String(article.writing_deadline),
    publication_deadline: String(article.publication_deadline),
    completed_date: article.completed_date ? String(article.completed_date) : null,
  }));

  return data;
}

function getStatusBadge(status: Article['status']) {
  const styles = {
    completed: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
    in_progress: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
    not_started: 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300',
  };

  const labels = {
    completed: '完了',
    in_progress: '執筆中',
    not_started: '未着手',
  };

  return (
    <span className={`px-2 py-1 text-xs font-medium rounded ${styles[status]}`}>
      {labels[status]}
    </span>
  );
}

export default async function LitePage() {
  const data = await getStatusData();

  return (
    <div className="min-h-screen bg-white dark:bg-gray-900">
      <div className="max-w-6xl mx-auto p-4 sm:p-6">
        <header className="mb-6 border-b border-gray-200 dark:border-gray-700 pb-4">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
            {data.title}
          </h1>
        </header>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-800 border-y border-gray-200 dark:border-gray-700">
              <tr>
                <th className="px-3 py-2 text-left font-medium text-gray-700 dark:text-gray-300">Day</th>
                <th className="px-3 py-2 text-left font-medium text-gray-700 dark:text-gray-300">タイトル</th>
                <th className="px-3 py-2 text-left font-medium text-gray-700 dark:text-gray-300">執筆締切</th>
                <th className="px-3 py-2 text-left font-medium text-gray-700 dark:text-gray-300">完了日</th>
                <th className="px-3 py-2 text-right font-medium text-gray-700 dark:text-gray-300">進捗</th>
                <th className="px-3 py-2 text-center font-medium text-gray-700 dark:text-gray-300">状態</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
              {data.articles.map((article) => (
                <tr key={article.day} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                  <td className="px-3 py-2 text-gray-900 dark:text-gray-100 font-medium">
                    {article.day}
                  </td>
                  <td className="px-3 py-2 text-gray-900 dark:text-gray-100">
                    {article.title}
                  </td>
                  <td className="px-3 py-2 text-gray-600 dark:text-gray-400">
                    {article.writing_deadline}
                  </td>
                  <td className="px-3 py-2 text-gray-600 dark:text-gray-400">
                    {article.completed_date || '-'}
                  </td>
                  <td className="px-3 py-2 text-right text-gray-900 dark:text-gray-100">
                    {article.progress}%
                  </td>
                  <td className="px-3 py-2 text-center">
                    {getStatusBadge(article.status)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

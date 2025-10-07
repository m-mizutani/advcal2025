import { promises as fs } from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { StatusData } from '@/types/status';
import ArticleTable from '@/components/ArticleTable';
import ProgressChart from '@/components/ProgressChart';
import OverallStats from '@/components/OverallStats';
import ReloadButton from '@/components/ReloadButton';

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

export default async function Home() {
  const data = await getStatusData();

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <div className="max-w-7xl mx-auto p-4 sm:p-8">
        <header className="mb-8">
          <div className="flex items-start justify-between">
            <div>
              <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-2">
                {data.title}
              </h1>
              <p className="text-gray-600 dark:text-gray-400">
                {data.description}
              </p>
              <p className="text-sm text-gray-500 dark:text-gray-500 mt-2">
                期間: {data.start_date} ~ {data.end_date}
              </p>
            </div>
            <ReloadButton />
          </div>
        </header>

        <div className="space-y-8">
          <OverallStats articles={data.articles} />
          <ProgressChart articles={data.articles} />
          <ArticleTable articles={data.articles} />
        </div>
      </div>
    </div>
  );
}

export interface Article {
  day: number;
  slug: string;
  title: string;
  scheduled_date: string;
  scheduled_time: string;
  writing_deadline: string;
  publication_deadline: string;
  status: 'not_started' | 'in_progress' | 'review' | 'completed' | 'published';
  progress: number;
  completed_date: string | null;
  notes: string;
}

export interface StatusData {
  title: string;
  description: string;
  start_date: string;
  end_date: string;
  articles: Article[];
}

'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export default function ReloadButton() {
  const router = useRouter();
  const [isReloading, setIsReloading] = useState(false);

  const handleReload = () => {
    setIsReloading(true);
    router.refresh();
    setTimeout(() => setIsReloading(false), 500);
  };

  return (
    <button
      onClick={handleReload}
      disabled={isReloading}
      className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white font-medium rounded-lg transition-colors"
      title="status.ymlを再読込"
    >
      <svg
        className={`w-5 h-5 ${isReloading ? 'animate-spin' : ''}`}
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
        />
      </svg>
      {isReloading ? '読込中...' : '再読込'}
    </button>
  );
}

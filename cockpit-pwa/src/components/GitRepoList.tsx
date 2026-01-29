'use client';

import { Badge } from '@/components/ui/badge';

export interface GitRepo {
  id: string;
  name: string;
  path?: string;
  branch?: string;
  status?: 'clean' | 'dirty' | 'ahead' | 'behind' | 'diverged';
  uncommittedCount?: number;
  aheadCount?: number;
  behindCount?: number;
  modifiedFiles?: string[];
  lastChecked?: number;
}

interface GitRepoListProps {
  repos: GitRepo[];
  onRepoTap?: (repo: GitRepo) => void;
}

const statusConfig: Record<NonNullable<GitRepo['status']>, {
  label: string;
  variant: 'default' | 'secondary' | 'destructive' | 'outline';
  icon: string;
}> = {
  clean: { label: 'Clean', variant: 'default', icon: '🟢' },
  dirty: { label: 'Dirty', variant: 'destructive', icon: '🔴' },
  ahead: { label: 'Ahead', variant: 'secondary', icon: '🔵' },
  behind: { label: 'Behind', variant: 'outline', icon: '🟠' },
  diverged: { label: 'Diverged', variant: 'destructive', icon: '🟣' },
};

export function GitRepoList({ repos, onRepoTap }: GitRepoListProps) {
  if (repos.length === 0) {
    return null;
  }

  const dirtyCount = repos.filter((r) => r.status === 'dirty').length;

  return (
    <div className="space-y-2">
      <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 px-1 flex items-center gap-2">
        <span>Git リポジトリ</span>
        {dirtyCount > 0 && (
          <Badge variant="secondary" className="text-xs">
            {dirtyCount} dirty
          </Badge>
        )}
      </h2>

      <ul className="space-y-2">
        {repos.map((repo) => (
          <GitRepoCard
            key={repo.id}
            repo={repo}
            onTap={onRepoTap ? () => onRepoTap(repo) : undefined}
          />
        ))}
      </ul>
    </div>
  );
}

interface GitRepoCardProps {
  repo: GitRepo;
  onTap?: () => void;
}

function GitRepoCard({ repo, onTap }: GitRepoCardProps) {
  const config = repo.status ? statusConfig[repo.status] : null;

  return (
    <li
      role={onTap ? 'button' : undefined}
      tabIndex={onTap ? 0 : undefined}
      onClick={onTap}
      onKeyDown={(e) => {
        if (onTap && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onTap();
        }
      }}
      className={`
        bg-white dark:bg-zinc-900
        rounded-xl
        border border-zinc-200 dark:border-zinc-800
        p-3
        flex items-center gap-3
        ${onTap ? 'cursor-pointer active:bg-zinc-50 dark:active:bg-zinc-800 transition-colors' : ''}
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500
      `}
    >
      {/* Status icon */}
      <span className="text-base flex-shrink-0" aria-hidden="true">
        {config?.icon || '📁'}
      </span>

      {/* Repo info */}
      <div className="flex-1 min-w-0">
        <p className="font-medium text-zinc-900 dark:text-zinc-100 truncate text-sm">
          {repo.name}
        </p>
        <div className="flex items-center gap-2 mt-0.5">
          {repo.branch && (
            <span className="text-xs text-zinc-500 dark:text-zinc-400 font-mono">
              {repo.branch}
            </span>
          )}
          {/* Ahead/Behind counts */}
          {(repo.aheadCount || repo.behindCount) && (
            <span className="text-xs text-zinc-400">
              {repo.aheadCount ? `+${repo.aheadCount}` : ''}
              {repo.aheadCount && repo.behindCount ? ' / ' : ''}
              {repo.behindCount ? `-${repo.behindCount}` : ''}
            </span>
          )}
        </div>
      </div>

      {/* Status badge */}
      <div className="flex items-center gap-2 flex-shrink-0">
        {repo.uncommittedCount && repo.uncommittedCount > 0 && (
          <span className="text-xs text-zinc-500 dark:text-zinc-400">
            {repo.uncommittedCount} files
          </span>
        )}
        {config && (
          <Badge variant={config.variant} className="text-xs">
            {config.label}
          </Badge>
        )}
      </div>
    </li>
  );
}

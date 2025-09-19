// 公共类型，集中管理，避免重复定义/循环依赖

export type ConfigRepo = { id: string; name: string };

export type AppConfig = {
    repos: ConfigRepo[];
    githubToken?: string;
    globalRefreshSeconds: number;
    repoUpdateIntervalSeconds: number;
    feedLimit: number;
    port: number;

    // ---- Code Audit ----
    codeAuditEnabled?: boolean;
    codeAuditIntervalHours: number;
    codeAuditTmpDir: string;
    codeAuditLang: string;
    codeAuditArgs: string;
    codeAuditMaxReports: number;

    // 可选：审计 CLI 名称（默认 "fuck-u-code" 与原实现兼容）
    codeAuditCli?: string;
};

export type RateLimitInfo = { limit: number; remaining: number; reset: number };

export type RepoInfo = {
    repo: string;
    displayName: string;
    html_url: string;
    description: string | null;
    stargazers_count: number;
    forks_count: number;
    open_issues_count: number;
    pushed_at: string;
    default_branch: string;
};

export type CommitStats = {
    sha: string;
    additions: number;
    deletions: number;
    filesChanged: number;
};

export type FeedItem = {
    type: string;
    icon: string;
    when: string;
    repo: string;
    actor?: string;
    title: string;
    url: string;
    extra?: string;
    sha?: string;
    stats?: CommitStats;
    displayName?: string; // 汇总时附加
};

export type QualityReport = {
    repo: string;
    displayName: string;
    score: number | null; // 0~100; null 表示未能解析
    markdown: string;     // 完整 Markdown 报告
    updatedAt: string;    // ISO
    localPath: string;    // 缓存目录
};

export type ETagCache = {
    info: Map<string, string>;
    events: Map<string, string>;
    commits: Map<string, string>;
};

// DataStore 接口，便于替换为持久化实现
export interface DataStore {
    repoInfos: Map<string, RepoInfo>;
    repoEvents: Map<string, any[]>;
    feedItems: FeedItem[];
    commitStats: Map<string, CommitStats>;
    qualityReports: Map<string, QualityReport>;
}
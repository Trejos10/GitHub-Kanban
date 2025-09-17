// src/server.ts
import { serveDir } from "https://deno.land/std@0.224.0/http/file_server.ts";
import * as path from "https://deno.land/std@0.224.0/path/mod.ts";

/** ---------------- Config ---------------- */
type ConfigRepo = { id: string; name: string };
type AppConfig = {
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
};

async function fileExists(p: string) {
  try {
    const st = await Deno.stat(p);
    return st.isFile || st.isDirectory;
  } catch {
    return false;
  }
}

async function loadConfig(): Promise<AppConfig> {
  const defaultPath = Deno.env.get("CONFIG_PATH") ?? "./config.json";
  let fileCfg: any = {};
  if (await fileExists(defaultPath)) {
    try {
      fileCfg = JSON.parse(await Deno.readTextFile(defaultPath));
    } catch (e) {
      console.error(`Error parsing config file at ${defaultPath}:`, e);
    }
  }

  const envReposRaw = Deno.env.get("REPOS");
  const envRepos = envReposRaw
    ? envReposRaw.split(",").map((s) => {
        const parts = s.trim().split(":");
        const id = parts[0];
        const name = parts.slice(1).join(":") || id;
        return { id, name };
      })
    : undefined;

  const env: Partial<AppConfig> = {
    repos: envRepos,
    githubToken: Deno.env.get("GITHUB_TOKEN") ?? fileCfg.githubToken ?? undefined,
    globalRefreshSeconds: Number(Deno.env.get("REFRESH_SECONDS") ?? NaN),
    repoUpdateIntervalSeconds: Number(
      Deno.env.get("REPO_UPDATE_INTERVAL_SECONDS") ?? NaN
    ),
    feedLimit: Number(Deno.env.get("FEED_LIMIT") ?? NaN),
    port: Number(Deno.env.get("PORT") ?? NaN),

    // ---- Code Audit envs ----
    codeAuditEnabled:
      (Deno.env.get("CODE_AUDIT_ENABLED") ?? "false").toLowerCase() === "true",
    codeAuditIntervalHours: Number(
      Deno.env.get("CODE_AUDIT_INTERVAL_HOURS") ?? NaN
    ),
    codeAuditTmpDir: Deno.env.get("CODE_AUDIT_TMP") ?? "",
    codeAuditLang: Deno.env.get("CODE_AUDIT_LANG") ?? "",
    codeAuditArgs: Deno.env.get("CODE_AUDIT_ARGS") ?? "",
    codeAuditMaxReports: Number(Deno.env.get("CODE_AUDIT_MAX_REPORTS") ?? NaN),
  };

  const cfgRepos = env.repos ?? fileCfg.repos ?? [];

  const cfg: AppConfig = {
    repos: cfgRepos.filter((r) => r && r.id),
    githubToken: env.githubToken ?? undefined,
    globalRefreshSeconds: Number.isFinite(env.globalRefreshSeconds)
      ? (env.globalRefreshSeconds as number)
      : fileCfg.refreshSeconds ?? 60,
    repoUpdateIntervalSeconds: Number.isFinite(env.repoUpdateIntervalSeconds)
      ? (env.repoUpdateIntervalSeconds as number)
      : fileCfg.repoUpdateIntervalSeconds ?? 10,
    feedLimit: Number.isFinite(env.feedLimit)
      ? (env.feedLimit as number)
      : fileCfg.feedLimit ?? 120,
    port: Number.isFinite(env.port)
      ? (env.port as number)
      : fileCfg.port ?? 8000,

    // defaults for code audit
    codeAuditEnabled: env.codeAuditEnabled ?? false,
    codeAuditIntervalHours: Number.isFinite(env.codeAuditIntervalHours)
      ? (env.codeAuditIntervalHours as number)
      : 4,
    codeAuditTmpDir: env.codeAuditTmpDir || path.join(".audit", "repos"),
    codeAuditLang: env.codeAuditLang || "zh-CN",
    codeAuditArgs: env.codeAuditArgs || "--summary --top 10 --issues 5",
    codeAuditMaxReports: Number.isFinite(env.codeAuditMaxReports)
      ? (env.codeAuditMaxReports as number)
      : 200,
  };

  if (!cfg.repos.length) {
    console.warn("[WARN] No repos configured. Falling back to demo repos.");
    cfg.repos = [
      { id: "vercel/next.js", name: "🚀 Next.js" },
      { id: "apache/superset", name: "📊 Superset" },
    ];
  }

  return cfg;
}

/** ---------------- GitHub fetch & cache ---------------- */
type RepoInfo = {
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
type FeedItem = {
  type: string;
  icon: string;
  when: string;
  repo: string;
  actor?: string;
  title: string;
  url: string;
  extra?: string;
  sha?: string;
  stats?: { sha: string; additions: number; deletions: number; filesChanged: number };
};
const ICONS: Record<string, string> = {
  PushEvent: "⬆️",
  PullRequestEvent: "🔀",
  IssuesEvent: "❗",
  IssueCommentEvent: "💬",
  CreateEvent: "🌱",
  DeleteEvent: "🗑️",
  ReleaseEvent: "🏷️",
  ForkEvent: "🍴",
  WatchEvent: "⭐",
  CommitCommentEvent: "📝",
  MemberEvent: "👥",
  public: "📣",
  default: "📌",
  Commit: "📝",
};

let RATE_LIMIT_INFO = { limit: 5000, remaining: 5000, reset: 0 };

function ghHeaders(token?: string, extra?: HeadersInit): Headers {
  const h = new Headers({
    Accept: "application/vnd.github+json",
    "User-Agent": "deno-github-dashboard",
  });
  if (token) h.set("Authorization", `Bearer ${token}`);
  if (extra) {
    for (const [k, v] of Object.entries(extra)) h.set(k, v as string);
  }
  return h;
}

type ETagCache = {
  info: Map<string, string>;
  events: Map<string, string>;
  commits: Map<string, string>;
};
const etags: ETagCache = { info: new Map(), events: new Map(), commits: new Map() };


let REPO_INFOS = new Map<string, RepoInfo>();
let FEED_ITEMS: FeedItem[] = [];

const COMMIT_STATS = new Map<string, { sha: string; additions: number; deletions: number; filesChanged: number }>();

function updateRateLimitInfo(res: Response) {
  RATE_LIMIT_INFO = {
    limit: parseInt(res.headers.get("x-ratelimit-limit") || "0", 10),
    remaining: parseInt(res.headers.get("x-ratelimit-remaining") || "0", 10),
    reset: parseInt(res.headers.get("x-ratelimit-reset") || "0", 10),
  };
}

async function fetchJsonWithEtag(
  url: string,
  token?: string,
  etagKey?: { map: Map<string, string>; key: string }
) {
  const hdrs: HeadersInit = {};
  if (etagKey) {
    const tag = etagKey.map.get(etagKey.key);
    if (tag) (hdrs as Record<string, string>)["If-None-Match"] = tag;
  }
  const res = await fetch(url, { headers: ghHeaders(token, hdrs) });

  updateRateLimitInfo(res);

  if (res.status === 304) return { status: 304 as const };
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText} for ${url} :: ${text}`);
  }
  const data = await res.json();
  const etag = res.headers.get("etag") ?? undefined;
  if (etag && etagKey) etagKey.map.set(etagKey.key, etag);
  return { status: 200 as const, data };
}

async function loadRepoInfo(
  repoId: string,
  token?: string
): Promise<any | null> {
  const url = `https://api.github.com/repos/${repoId}`;
  const out = await fetchJsonWithEtag(url, token, {
    map: etags.info,
    key: repoId,
  });
  if (out.status === 304) {
    return REPO_INFOS.get(repoId) ?? null;
  }
  const info = out.data;
  return {
    repo: repoId,
    html_url: info.html_url,
    description: info.description,
    stargazers_count: info.stargazers_count,
    forks_count: info.forks_count,
    open_issues_count: info.open_issues_count,
    pushed_at: info.updated_at,
    default_branch: info.default_branch,
  };
}

async function loadRepoEvents(repoId: string, token?: string) {
  const url = `https://api.github.com/networks/${repoId}/events?per_page=30`;
  const out = await fetchJsonWithEtag(url, token, {
    map: etags.events,
    key: repoId,
  });
  if (out.status === 304) return [];
  const events = out.data as any[];
  return events.map((ev) => ({ ...ev, __repo: repoId }));
}

async function loadCommitStats(repoId: string, sha: string, token?: string) {
  const key = `${repoId}@${sha}`;
  if (COMMIT_STATS.has(key)) return COMMIT_STATS.get(key)!;
  const url = `https://api.github.com/repos/${repoId}/commits/${sha}`;
  const out = await fetchJsonWithEtag(url, token, { map: etags.commits, key });
  if (out.status === 304) return COMMIT_STATS.get(key) ?? { sha, additions: 0, deletions: 0, filesChanged: 0 };
  const data = out.data;
  const additions = data?.stats?.additions ?? 0;
  const deletions = data?.stats?.deletions ?? 0;
  const filesChanged = Array.isArray(data?.files) ? data.files.length : (data?.stats?.total ?? 0);
  const stats = { sha, additions, deletions, filesChanged };
  COMMIT_STATS.set(key, stats);
  return stats;
}


/** ---------------- Event Processing Logic ---------------- */
function eventToFeedItems(ev: any): FeedItem[] {
  const type = ev.type ?? "default";
  const repo = ev.__repo as string;
  const actor = ev.actor?.display_login ?? ev.actor?.login;
  const urlBase = `https://github.com/${repo}`;
  try {
    const p = ev.payload ?? {};
    if (type === "PushEvent" && p.commits) {
      const branch = (p.ref ?? "").replace("refs/heads/", "");
      return p.commits.map((commit: any) => ({
        type: "Commit",
        icon: "📝",
        when: ev.created_at,
        repo,
        actor,
        title: `Commit to ${branch}: ${commit.message.split("\n")[0]}`,
        url: `${urlBase}/commit/${commit.sha}`,
        sha: commit.sha,
        extra: `by ${commit.author.name}`,
      }));
    }
    let title = "",
      url = urlBase,
      extra = "";
    if (type === "PullRequestEvent") {
      const pr = p.pull_request ?? {};
      title = `PR ${p.action} #${pr.number}: ${pr.title ?? ""}`;
      url = pr.html_url ?? url;
      if (p.action === "closed" && pr.merged) extra = "已合并";
    } else if (type === "IssuesEvent") {
      const is = p.issue ?? {};
      title = `Issue ${p.action} #${is.number}: ${is.title ?? ""}`;
      url = is.html_url ?? url;
    } else if (type === "IssueCommentEvent") {
      const is = p.issue ?? {};
      title = `Issue 评论 #${is.number}: ${is.title ?? ""}`;
      url = p.comment?.html_url ?? is.html_url ?? url;
    } else if (type === "ReleaseEvent") {
      const rel = p.release ?? {};
      title = `发布 ${p.action}: ${rel.tag_name ?? ""}`;
      url = rel.html_url ?? url;
    } else if (type === "CreateEvent") {
      title = `创建 ${p.ref_type}: ${p.ref}`;
    } else if (type === "DeleteEvent") {
      title = `删除 ${p.ref_type}: ${p.ref}`;
    } else if (type === "ForkEvent") {
      title = "Fork 了仓库";
      url = p.forkee?.html_url ?? url;
    } else if (type === "WatchEvent") {
      title = "Star 了仓库";
    } else {
      title = type;
    }
    return [
      {
        type,
        icon: ICONS[type] ?? ICONS.default,
        when: ev.created_at,
        repo,
        actor,
        title,
        url,
        extra,
      },
    ];
  } catch (e) {
    console.error(`Error parsing event type ${type} for repo ${repo}:`, e);
    return [];
  }
}
function byDescTime(a: FeedItem, b: FeedItem) {
  return new Date(b.when).getTime() - new Date(a.when).getTime();
}

const REPO_EVENTS = new Map<string, any[]>();

function rebuildGlobalFeed(cfg: AppConfig) {
    const allEvents = Array.from(REPO_EVENTS.values()).flat();
    const repoNameMap = new Map(cfg.repos.map(r => [r.id, r.name]));

    FEED_ITEMS = allEvents
      .flatMap(eventToFeedItems)
      .map(item => ({
        ...item,
        displayName: repoNameMap.get(item.repo) || item.repo,
        stats: (item.type === "Commit" && item.sha)
          ? COMMIT_STATS.get(`${item.repo}@${item.sha}`)
          : undefined
      }))
      .sort(byDescTime)
      .slice(0, cfg.feedLimit);
}

/** ---------------- Update Scheduler ---------------- */
class UpdateScheduler {
  private queue: ConfigRepo[] = [];
  private timer: number | null = null;

  constructor(private cfg: AppConfig) {}

  async initialLoad() {
    console.log(
      `[Scheduler] 🚀 Starting initial load for ${this.cfg.repos.length} repos...`
    );
    const t0 = Date.now();
    await Promise.allSettled(
      this.cfg.repos.map((repo) => this.updateRepo(repo))
    );
    rebuildGlobalFeed(this.cfg);
    console.log(
      `[Scheduler] ✅ Initial load complete in ${
        Date.now() - t0
      }ms. Rate limit: ${RATE_LIMIT_INFO.remaining}/${RATE_LIMIT_INFO.limit}`
    );
    this.start();
  }

  start() {
    if (this.timer) clearInterval(this.timer);
    this.buildQueue();
    const interval = this.cfg.repoUpdateIntervalSeconds * 1000;
    console.log(
      `[Scheduler] 🕒 Starting periodic updates. Updating one repo every ${this.cfg.repoUpdateIntervalSeconds} seconds.`
    );
    this.timer = setInterval(() => this.tick(), interval);
  }

  private buildQueue() {
    const sortedRepos = [...this.cfg.repos].sort((a, b) => {
      const infoA = REPO_INFOS.get(a.id);
      const infoB = REPO_INFOS.get(b.id);
      if (!infoA || !infoB) return 0;
      return (
        new Date(infoB.pushed_at).getTime() -
        new Date(infoA.pushed_at).getTime()
      );
    });
    this.queue = sortedRepos;
    console.log(
      `[Scheduler] 🔄 Rebuilt update queue. Priority: ${this.queue
        .map((r) => r.name)
        .slice(0, 3)
        .join(", ")}...`
    );
  }

  private async tick() {
    if (this.queue.length === 0) {
      this.buildQueue();
    }
    const repo = this.queue.shift();
    if (repo) {
      await this.updateRepo(repo);
      rebuildGlobalFeed(this.cfg);
    }
  }

  private async updateRepo(repo: ConfigRepo) {
    const t0 = Date.now();
    console.log(`[Update] ⏳ Updating ${repo.name} (${repo.id})...`);
    try {
      const [infoResult, eventsResult] = await Promise.allSettled([
        loadRepoInfo(repo.id, this.cfg.githubToken),
        loadRepoEvents(repo.id, this.cfg.githubToken),
      ]);

      if (infoResult.status === "fulfilled" && infoResult.value) {
        const info = infoResult.value;
        REPO_INFOS.set(repo.id, { ...info, displayName: repo.name });
      } else if (infoResult.status === "rejected") {
        console.error(
          `[Update] ❌ Failed to fetch info for ${repo.name}:`,
          infoResult.reason
        );
      }

      if (eventsResult.status === "fulfilled") {
        const events = eventsResult.value;
        if (events.length > 0 || !REPO_EVENTS.has(repo.id)) {
          REPO_EVENTS.set(repo.id, events);
        }
        const commits: string[] = [];
        for (const ev of events) {
          if (ev.type === "PushEvent" && ev.payload?.commits) {
            for (const c of ev.payload.commits) commits.push(c.sha);
          }
        }
        const toFetch = commits.filter(sha => !COMMIT_STATS.has(`${repo.id}@${sha}`)).slice(0, 5);
        await Promise.allSettled(toFetch.map(sha => loadCommitStats(repo.id, sha, this.cfg.githubToken)));

      } else if (eventsResult.status === "rejected") {
        console.error(
          `[Update] ❌ Failed to fetch events for ${repo.name}:`,
          eventsResult.reason
        );
      }

      const resetTime = new Date(
        RATE_LIMIT_INFO.reset * 1000
      ).toLocaleTimeString();
      console.log(
        `[Update] ✅ Finished ${repo.name} in ${
          Date.now() - t0
        }ms. Rate limit: ${RATE_LIMIT_INFO.remaining}/${
          RATE_LIMIT_INFO.limit
        } (resets at ${resetTime})`
      );
    } catch (e) {
      console.error(`[Update] 💥 Unhandled error for ${repo.name}:`, e);
    }
  }
}

/** ---------------- Code Audit (fuck-u-code) ---------------- */
type QualityReport = {
  repo: string;
  displayName: string;
  score: number | null;     // 0~100; null 表示未能解析
  markdown: string;         // 完整 Markdown 报告
  updatedAt: string;        // ISO
  localPath: string;        // 缓存目录
};

const QUALITY_REPORTS = new Map<string, QualityReport>();

async function run(cmd: string, args: string[], opts: { cwd?: string } = {}) {
  const p = new Deno.Command(cmd, { args, cwd: opts.cwd, stdin: "null", stdout: "piped", stderr: "piped" });
  const { code, stdout, stderr } = await p.output();
  const dec = new TextDecoder();
  return { code, out: dec.decode(stdout), err: dec.decode(stderr) };
}

function parseShitIndex(markdown: string): number | null {
  const regs = [
    /质量评分[^\d]{0,10}(\d+(?:\.\d+)?)\/100/i,
  ];
  for (const r of regs) {
    const m = r.exec(markdown);
    if (m) {
      const v = parseFloat(m[1]);
      if (!Number.isNaN(v) && v >= 0 && v <= 100) return v;
    }
  }
  return null;
}

function repoDir(base: string, repoId: string) {
  return path.join(base, repoId.replace(/\//g, "__"));
}

async function ensureRepo(cloneBase: string, repoId: string, token?: string, defaultBranch?: string) {
  const dir = repoDir(cloneBase, repoId);
  const exists = await fileExists(path.join(dir, ".git"));
  const branch = defaultBranch || "main";

  await Deno.mkdir(dir, { recursive: true });

  if (!exists) {
    const remote = token ? `https://${encodeURIComponent(token)}@github.com/${repoId}.git`
                         : `https://github.com/${repoId}.git`;
    console.log(`[Audit] Cloning ${repoId} -> ${dir}`);
    const ret = await run("git", ["clone", "--depth", "1", "-b", branch, remote, dir]);
    if (ret.code !== 0) {
      // 尝试不指定分支（兼容 master）
      const retry = await run("git", ["clone", "--depth", "1", remote, dir]);
      if (retry.code !== 0) throw new Error(`git clone failed: ${ret.err || retry.err}`);
    }
    // 清除含 token 的 remote url
    await run("git", ["-C", dir, "remote", "set-url", "origin", `https://github.com/${repoId}.git`]);
  } else {
    await run("git", ["-C", dir, "fetch", "origin", "--prune"]);
    // 确定默认分支
    const def = defaultBranch || "main";
    await run("git", ["-C", dir, "checkout", def]).catch(()=>{});
    await run("git", ["-C", dir, "reset", "--hard", `origin/${def}`]);
  }

  return dir;
}

async function runFuckUCode(scanPath: string, lang: string, extraArgs: string) {
  const args = ["analyze", "--markdown", "--lang", lang, ...extraArgs.split(" ").filter(Boolean), scanPath];
  const ret = await run("fuck-u-code", args);
  if (ret.code !== 0 && !ret.out) {
    throw new Error(`fuck-u-code failed: ${ret.err}`);
  }
  return ret.out || ret.err || "";
}

class CodeAuditScheduler {
  private running = false;
  constructor(private cfg: AppConfig) {}
  start() {
    if (!this.cfg.codeAuditEnabled) return;
    const ms = Math.max(1, this.cfg.codeAuditIntervalHours) * 3600_000;
    console.log(`[Audit] 🧪 Code audit enabled. Interval: ${this.cfg.codeAuditIntervalHours}h`);
    this.cycle(); // 立即跑一轮
    setInterval(()=> this.cycle(), ms);
  }
  private async cycle() {
    if (this.running) return;
    this.running = true;
    try {
      await Deno.mkdir(this.cfg.codeAuditTmpDir, { recursive: true });
      for (const r of this.cfg.repos) {
        try {
          const def = REPO_INFOS.get(r.id)?.default_branch ?? "main";
          const dir = await ensureRepo(this.cfg.codeAuditTmpDir, r.id, this.cfg.githubToken, def);
          const output = await runFuckUCode(dir, this.cfg.codeAuditLang, this.cfg.codeAuditArgs);
          const score = parseShitIndex(output);
          const rep: QualityReport = {
            repo: r.id,
            displayName: r.name,
            score,
            markdown: output || "*（空）*",
            updatedAt: new Date().toISOString(),
            localPath: dir,
          };
          QUALITY_REPORTS.set(r.id, rep);
          if (QUALITY_REPORTS.size > this.cfg.codeAuditMaxReports) {
            const firstKey = QUALITY_REPORTS.keys().next().value;
            if (firstKey) QUALITY_REPORTS.delete(firstKey);
          }
          console.log(`[Audit] ✓ ${r.name} (${r.id}) score=${score ?? "N/A"}`);
        } catch (e) {
          console.error(`[Audit] ✗ ${r.name} (${r.id}) failed:`, e);
        }
      }
    } finally {
      this.running = false;
    }
  }
}

/** ---------------- HTTP server ---------------- */
async function main() {
  const cfg = await loadConfig();

  const scheduler = new UpdateScheduler(cfg);
  await scheduler.initialLoad();

  // Periodically rebuild the queue to re-prioritize based on new activity
  setInterval(() => scheduler.start(), cfg.globalRefreshSeconds * 1000);

  // Start the code audit scheduler
  new CodeAuditScheduler(cfg).start();

  function json(data: unknown, init?: ResponseInit) {
    return new Response(JSON.stringify(data), {
      headers: { "content-type": "application/json; charset=utf-8" },
      ...init,
    });
  }

  Deno.serve({ port: cfg.port }, (req: Request) => {
    const url = new URL(req.url);
    const pathName = url.pathname;
    
    if (pathName === "/healthz") return new Response("ok");

    if (pathName === "/api/summary")
      return json({ repos: Array.from(REPO_INFOS.values()) });

    if (pathName === "/api/feed") {
        const items = FEED_ITEMS.map(it => {
          if (it.type === "Commit" && it.sha) {
            const cached = COMMIT_STATS.get(`${it.repo}@${it.sha}`);
            return cached ? { ...it, stats: cached } : it;
          }
          return it;
        });
        return json({ items });
    }
    
    // New: Code Quality API
    if (pathName === "/api/quality") {
      const repoQuery = url.searchParams.get("repo");
      if (repoQuery) {
        const rep = QUALITY_REPORTS.get(repoQuery);
        if (!rep) return json({ error: "not_found" }, { status: 404 });
        return json(rep);
      }
      const list = Array.from(QUALITY_REPORTS.values())
        .sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
        .map(({ markdown, ...rest }) => rest); // Exclude large markdown from list
      return json({ items: list });
    }

    return serveDir(req, { fsRoot: "public", urlRoot: "" });
  });

  console.log(
    `\n🚀 GitHub Dashboard is running at http://localhost:${cfg.port}`
  );
  console.log(
    `   Watching ${cfg.repos.length} repos: ${cfg.repos
      .map((r) => r.name)
      .join(", ")}`
  );
  console.log(
    `   Individual repo update interval: ${cfg.repoUpdateIntervalSeconds}s`
  );
  console.log(`   Queue re-sort interval: ${cfg.globalRefreshSeconds}s`);
}

main();

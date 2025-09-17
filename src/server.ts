// src/server.ts
import { serveDir } from "https://deno.land/std@0.224.0/http/file_server.ts";

/** ---------------- Config ---------------- */
type ConfigRepo = { id: string; name: string };
type AppConfig = {
  repos: ConfigRepo[];
  githubToken?: string;
  globalRefreshSeconds: number; // Renamed from refreshSeconds for clarity
  repoUpdateIntervalSeconds: number; // New: interval between individual repo updates
  feedLimit: number;
  port: number;
};

async function fileExists(path: string) {
  try {
    const st = await Deno.stat(path);
    return st.isFile;
  } catch {
    return false;
  }
}

async function loadConfig(): Promise<AppConfig> {
  const defaultPath = Deno.env.get("CONFIG_PATH") ?? "./config.json";
  let fileCfg: Partial<AppConfig> = {};
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
    githubToken: Deno.env.get("GITHUB_TOKEN") ?? undefined,
    globalRefreshSeconds: Number(Deno.env.get("REFRESH_SECONDS") ?? NaN), // Still support old env var
    repoUpdateIntervalSeconds: Number(
      Deno.env.get("REPO_UPDATE_INTERVAL_SECONDS") ?? NaN
    ),
    feedLimit: Number(Deno.env.get("FEED_LIMIT") ?? NaN),
    port: Number(Deno.env.get("PORT") ?? NaN),
  };

  const cfgRepos = env.repos ?? fileCfg.repos ?? [];

  const cfg: AppConfig = {
    repos: cfgRepos.filter((r) => r && r.id),
    githubToken: env.githubToken ?? fileCfg.githubToken ?? undefined,
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

type ETagCache = { info: Map<string, string>; events: Map<string, string> };
const etags: ETagCache = { info: new Map(), events: new Map() };

let REPO_INFOS = new Map<string, RepoInfo>();
let FEED_ITEMS: FeedItem[] = [];

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

// Map to store events per repo to avoid re-processing
const REPO_EVENTS = new Map<string, any[]>();

// Rebuild the global feed from cached per-repo events
function rebuildGlobalFeed(cfg: AppConfig) {
    const allEvents = Array.from(REPO_EVENTS.values()).flat();
    const repoNameMap = new Map(cfg.repos.map(r => [r.id, r.name]));

    FEED_ITEMS = allEvents
      .flatMap(eventToFeedItems) // Returns items with just the repo ID
      .map(item => ({          // <-- ADDED THIS .map() STEP
          ...item,
          // Enrich the item with its displayName
          displayName: repoNameMap.get(item.repo) || item.repo 
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
    // Sort repos by most recently pushed to prioritize active repos
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
      // Fetch info and events concurrently for a single repo
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
        // Only update if we got new data (not from 304)
        if (events.length > 0 || !REPO_EVENTS.has(repo.id)) {
          REPO_EVENTS.set(repo.id, events);
        }
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

/** ---------------- HTTP server ---------------- */
async function main() {
  const cfg = await loadConfig();

  const scheduler = new UpdateScheduler(cfg);
  await scheduler.initialLoad();

  // Periodically rebuild the queue to re-prioritize based on new activity
  setInterval(() => scheduler.start(), cfg.globalRefreshSeconds * 1000);

  function json(data: unknown, init?: ResponseInit) {
    return new Response(JSON.stringify(data), {
      headers: { "content-type": "application/json; charset=utf-8" },
      ...init,
    });
  }

  Deno.serve({ port: cfg.port }, (req: Request) => {
    const path = new URL(req.url).pathname;
    if (path === "/healthz") return new Response("ok");
    if (path === "/api/summary")
      return json({ repos: Array.from(REPO_INFOS.values()) });
    if (path === "/api/feed") return json({ items: FEED_ITEMS });
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

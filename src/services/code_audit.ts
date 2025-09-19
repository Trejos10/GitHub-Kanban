import * as path from "https://deno.land/std@0.224.0/path/mod.ts";
import { AppConfig, DataStore, QualityReport } from "../types.ts";

async function fileExists(p: string) {
    try {
        const st = await Deno.stat(p);
        return st.isFile || st.isDirectory;
    } catch {
        return false;
    }
}

async function run(cmd: string, args: string[], opts: { cwd?: string } = {}) {
    const p = new Deno.Command(cmd, { args, cwd: opts.cwd, stdin: "null", stdout: "piped", stderr: "piped" });
    const { code, stdout, stderr } = await p.output();
    const dec = new TextDecoder();
    return { code, out: dec.decode(stdout), err: dec.decode(stderr) };
}

function parseQualityScore(markdown: string): number | null {
    const regs = [/质量评分[^\d]{0,10}(\d+(?:\.\d+)?)\/100/i];
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
        const remote = token
            ? `https://${encodeURIComponent(token)}@github.com/${repoId}.git`
            : `https://github.com/${repoId}.git`;
        console.log(`[Audit] Cloning ${repoId} -> ${dir}`);
        const ret = await run("git", ["clone", "--depth", "1", "-b", branch, remote, dir]);
        if (ret.code !== 0) {
            const retry = await run("git", ["clone", "--depth", "1", remote, dir]);
            if (retry.code !== 0) throw new Error(`git clone failed: ${ret.err || retry.err}`);
        }
        await run("git", ["-C", dir, "remote", "set-url", "origin", `https://github.com/${repoId}.git`]);
    } else {
        await run("git", ["-C", dir, "fetch", "origin", "--prune"]);
        await run("git", ["-C", dir, "checkout", branch]).catch(() => { });
        await run("git", ["-C", dir, "reset", "--hard", `origin/${branch}`]);
    }
    return dir;
}

async function runAuditCLI(cli: string, scanPath: string, lang: string, extraArgs: string) {
    const args = ["analyze", "--markdown", "--lang", lang, ...extraArgs.split(" ").filter(Boolean), scanPath];
    const ret = await run(cli, args);
    if (ret.code !== 0 && !ret.out) {
        throw new Error(`${cli} failed: ${ret.err}`);
    }
    return ret.out || ret.err || "";
}

export class CodeAuditScheduler {
    private running = false;

    constructor(private cfg: AppConfig, private store: DataStore) { }

    start() {
        if (!this.cfg.codeAuditEnabled) return;
        const ms = Math.max(1, this.cfg.codeAuditIntervalHours) * 3600_000;
        console.log(`[Audit] 🧪 enabled: every ${this.cfg.codeAuditIntervalHours}h`);
        this.cycle(); // 立即跑一轮
        setInterval(() => this.cycle(), ms);
    }

    private async cycle() {
        if (this.running) return;
        this.running = true;
        try {
            await Deno.mkdir(this.cfg.codeAuditTmpDir, { recursive: true });
            for (const r of this.cfg.repos) {
                try {
                    const def = this.store.repoInfos.get(r.id)?.default_branch ?? "main";
                    const dir = await ensureRepo(this.cfg.codeAuditTmpDir, r.id, this.cfg.githubToken, def);
                    const output = await runAuditCLI(this.cfg.codeAuditCli ?? "fuck-u-code", dir, this.cfg.codeAuditLang, this.cfg.codeAuditArgs);
                    const score = parseQualityScore(output);
                    const rep: QualityReport = {
                        repo: r.id,
                        displayName: r.name,
                        score,
                        markdown: output || "*（空）*",
                        updatedAt: new Date().toISOString(),
                        localPath: dir,
                    };
                    this.store.qualityReports.set(r.id, rep);
                    // 控制最多保存数量
                    if (this.store.qualityReports.size > this.cfg.codeAuditMaxReports) {
                        const firstKey = this.store.qualityReports.keys().next().value;
                        if (firstKey) this.store.qualityReports.delete(firstKey);
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
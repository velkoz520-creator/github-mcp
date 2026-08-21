import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER || '';
const PORT = process.env.PORT || 3000;

if (!GITHUB_TOKEN) {
  console.error('❌ GITHUB_TOKEN is required');
  process.exit(1);
}

async function gh(path, options = {}) {
  const url = `https://api.github.com${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API ${res.status} ${res.statusText}: ${body}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

function owner(o) {
  const resolved = o || GITHUB_OWNER;
  if (!resolved) throw new Error('owner 未指定，请设置 GITHUB_OWNER 环境变量或传入 owner 参数');
  return resolved;
}

// 通用的 commit 推送函数，push_files 和 patch_file 共用
async function commitFiles(own, repo, br, message, fileContents) {
  const ref = await gh(`/repos/${own}/${repo}/git/ref/heads/${br}`);
  const latestCommitSha = ref.object.sha;
  const latestCommit = await gh(`/repos/${own}/${repo}/git/commits/${latestCommitSha}`);
  const baseTreeSha = latestCommit.tree.sha;

  const treeItems = [];
  for (const file of fileContents) {
    const blob = await gh(`/repos/${own}/${repo}/git/blobs`, {
      method: 'POST',
      body: JSON.stringify({ content: file.content, encoding: 'utf-8' }),
    });
    treeItems.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha });
  }

  const newTree = await gh(`/repos/${own}/${repo}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({ base_tree: baseTreeSha, tree: treeItems }),
  });

  const newCommit = await gh(`/repos/${own}/${repo}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({ message, tree: newTree.sha, parents: [latestCommitSha] }),
  });

  await gh(`/repos/${own}/${repo}/git/refs/heads/${br}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: newCommit.sha }),
  });

  return newCommit;
}

function createServer() {
  const server = new McpServer({ name: 'github-mcp', version: '1.3.0' });

  // ─── create_repo ───
  server.tool(
    'create_repo', '创建 GitHub 仓库',
    {
      name: z.string().describe('仓库名'),
      description: z.string().optional().describe('仓库描述'),
      is_private: z.boolean().optional().describe('是否私有，默认 true'),
    },
    async ({ name, description, is_private }) => {
      const repo = await gh('/user/repos', {
        method: 'POST',
        body: JSON.stringify({ name, description: description || '', private: is_private ?? true, auto_init: true }),
      });
      return { content: [{ type: 'text', text: JSON.stringify({ full_name: repo.full_name, url: repo.html_url, clone_url: repo.clone_url, private: repo.private }, null, 2) }] };
    }
  );

  // ─── list_repos ───
  server.tool(
    'list_repos', '列出你的 GitHub 仓库',
    {
      per_page: z.number().optional().describe('每页数量，默认 30'),
      page: z.number().optional().describe('页码，默认 1'),
    },
    async ({ per_page, page }) => {
      const repos = await gh(`/user/repos?sort=updated&per_page=${per_page || 30}&page=${page || 1}`);
      const list = repos.map((r) => ({ name: r.full_name, private: r.private, url: r.html_url, updated: r.updated_at }));
      return { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }] };
    }
  );

  // ─── push_files ───
  server.tool(
    'push_files', '批量推送文件到仓库（单次 commit，可创建或更新文件）',
    {
      owner: z.string().optional().describe('仓库所有者，默认用 GITHUB_OWNER'),
      repo: z.string().describe('仓库名'),
      branch: z.string().optional().describe('分支名，默认 main'),
      message: z.string().describe('commit 信息'),
      files: z.array(z.object({
        path: z.string().describe('文件路径，如 src/index.js'),
        content: z.string().describe('文件内容'),
      })).describe('要推送的文件列表'),
    },
    async ({ owner: o, repo, branch, message, files }) => {
      const own = owner(o);
      const br = branch || 'main';
      const newCommit = await commitFiles(own, repo, br, message, files);
      return { content: [{ type: 'text', text: JSON.stringify({ commit: newCommit.sha, message: newCommit.message, files_pushed: files.map((f) => f.path), url: `https://github.com/${own}/${repo}/commit/${newCommit.sha}` }, null, 2) }] };
    }
  );

  // ─── patch_file ───
  server.tool(
    'patch_file', '局部修改仓库中的文件（查找并替换），不需要重写整个文件',
    {
      owner: z.string().optional().describe('仓库所有者'),
      repo: z.string().describe('仓库名'),
      path: z.string().describe('文件路径'),
      branch: z.string().optional().describe('分支名，默认 main'),
      message: z.string().describe('commit 信息'),
      old_str: z.string().describe('要替换的原文（必须在文件中唯一出现）'),
      new_str: z.string().describe('替换为的新内容（留空则删除）'),
    },
    async ({ owner: o, repo, path, branch, message, old_str, new_str }) => {
      const own = owner(o);
      const br = branch || 'main';

      // 1. 服务端读文件
      const file = await gh(`/repos/${own}/${repo}/contents/${path}?ref=${br}`);
      const content = Buffer.from(file.content, 'base64').toString('utf-8');

      // 2. 检查 old_str 唯一性
      const count = content.split(old_str).length - 1;
      if (count === 0) {
        return { content: [{ type: 'text', text: `❌ 未找到匹配内容，文件中不存在这段文本。\n\n查找的内容：\n${old_str.slice(0, 200)}` }] };
      }
      if (count > 1) {
        return { content: [{ type: 'text', text: `❌ 找到 ${count} 处匹配，old_str 必须唯一。请提供更多上下文来精确定位。` }] };
      }

      // 3. 替换
      const newContent = content.replace(old_str, new_str ?? '');

      // 4. 推送
      const newCommit = await commitFiles(own, repo, br, message, [{ path, content: newContent }]);

      return { content: [{ type: 'text', text: JSON.stringify({ commit: newCommit.sha, message: newCommit.message, file: path, url: `https://github.com/${own}/${repo}/commit/${newCommit.sha}` }, null, 2) }] };
    }
  );

  // ─── get_file ───
  server.tool(
    'get_file', '读取仓库中某个文件的内容',
    {
      owner: z.string().optional().describe('仓库所有者'),
      repo: z.string().describe('仓库名'),
      path: z.string().describe('文件路径'),
      branch: z.string().optional().describe('分支名，默认 main'),
    },
    async ({ owner: o, repo, path, branch }) => {
      const own = owner(o);
      const file = await gh(`/repos/${own}/${repo}/contents/${path}?ref=${branch || 'main'}`);
      const content = Buffer.from(file.content, 'base64').toString('utf-8');
      return { content: [{ type: 'text', text: content }] };
    }
  );

  // ─── list_files ───
  server.tool(
    'list_files', '列出仓库目录结构（支持递归）',
    {
      owner: z.string().optional().describe('仓库所有者'),
      repo: z.string().describe('仓库名'),
      path: z.string().optional().describe('目录路径，默认根目录'),
      branch: z.string().optional().describe('分支名，默认 main'),
      recursive: z.boolean().optional().describe('是否递归列出所有文件，默认 false'),
    },
    async ({ owner: o, repo, path, branch, recursive }) => {
      const own = owner(o);
      const br = branch || 'main';
      if (recursive) {
        const ref = await gh(`/repos/${own}/${repo}/git/ref/heads/${br}`);
        const commit = await gh(`/repos/${own}/${repo}/git/commits/${ref.object.sha}`);
        const tree = await gh(`/repos/${own}/${repo}/git/trees/${commit.tree.sha}?recursive=1`);
        const items = tree.tree.filter((t) => t.type === 'blob').map((t) => ({ path: t.path, size: t.size }));
        return { content: [{ type: 'text', text: JSON.stringify(items, null, 2) }] };
      }
      const p = path ? `/repos/${own}/${repo}/contents/${path}?ref=${br}` : `/repos/${own}/${repo}/contents?ref=${br}`;
      const items = await gh(p);
      if (Array.isArray(items)) {
        const list = items.map((i) => ({ name: i.name, path: i.path, type: i.type, size: i.size }));
        return { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify({ name: items.name, path: items.path, type: items.type, size: items.size }, null, 2) }] };
    }
  );

  // ─── delete_files ───
  server.tool(
    'delete_files', '从仓库中删除文件（单次 commit）',
    {
      owner: z.string().optional().describe('仓库所有者'),
      repo: z.string().describe('仓库名'),
      branch: z.string().optional().describe('分支名，默认 main'),
      message: z.string().describe('commit 信息'),
      paths: z.array(z.string()).describe('要删除的文件路径列表'),
    },
    async ({ owner: o, repo, branch, message, paths }) => {
      const own = owner(o);
      const br = branch || 'main';
      const ref = await gh(`/repos/${own}/${repo}/git/ref/heads/${br}`);
      const latestCommitSha = ref.object.sha;
      const latestCommit = await gh(`/repos/${own}/${repo}/git/commits/${latestCommitSha}`);
      const treeItems = paths.map((p) => ({ path: p, mode: '100644', type: 'blob', sha: null }));
      const newTree = await gh(`/repos/${own}/${repo}/git/trees`, {
        method: 'POST',
        body: JSON.stringify({ base_tree: latestCommit.tree.sha, tree: treeItems }),
      });
      const newCommit = await gh(`/repos/${own}/${repo}/git/commits`, {
        method: 'POST',
        body: JSON.stringify({ message, tree: newTree.sha, parents: [latestCommitSha] }),
      });
      await gh(`/repos/${own}/${repo}/git/refs/heads/${br}`, {
        method: 'PATCH',
        body: JSON.stringify({ sha: newCommit.sha }),
      });
      return { content: [{ type: 'text', text: JSON.stringify({ commit: newCommit.sha, deleted: paths, url: `https://github.com/${own}/${repo}/commit/${newCommit.sha}` }, null, 2) }] };
    }
  );

  // ─── delete_repo ───
  server.tool(
    'delete_repo', '删除 GitHub 仓库（需要确认仓库名）',
    {
      owner: z.string().optional().describe('仓库所有者'),
      repo: z.string().describe('仓库名'),
      confirm: z.string().describe('再次输入仓库名以确认删除'),
    },
    async ({ owner: o, repo, confirm }) => {
      if (confirm !== repo) return { content: [{ type: 'text', text: '❌ 确认名称不匹配，已取消删除' }] };
      const own = owner(o);
      await gh(`/repos/${own}/${repo}`, { method: 'DELETE' });
      return { content: [{ type: 'text', text: `✅ 已删除仓库 ${own}/${repo}` }] };
    }
  );

  // ─── list_commits ───
  server.tool(
    'list_commits', '列出仓库的提交历史（可选按分支、按文件路径过滤）',
    {
      owner: z.string().optional().describe('仓库所有者'),
      repo: z.string().describe('仓库名'),
      branch: z.string().optional().describe('分支名，默认 main'),
      path: z.string().optional().describe('只看某个文件/目录的提交历史'),
      per_page: z.number().optional().describe('每页数量，默认 30'),
      page: z.number().optional().describe('页码，默认 1'),
    },
    async ({ owner: o, repo, branch, path, per_page, page }) => {
      const own = owner(o);
      const params = new URLSearchParams({
        sha: branch || 'main',
        per_page: String(per_page || 30),
        page: String(page || 1),
      });
      if (path) params.set('path', path);
      const commits = await gh(`/repos/${own}/${repo}/commits?${params.toString()}`);
      const list = commits.map((c) => ({
        sha: c.sha,
        message: c.commit.message,
        author: c.commit.author?.name,
        date: c.commit.author?.date,
        url: c.html_url,
      }));
      return { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }] };
    }
  );

  // ─── get_commit ───
  server.tool(
    'get_commit', '获取某次提交的完整详情（含每个文件的 diff）',
    {
      owner: z.string().optional().describe('仓库所有者'),
      repo: z.string().describe('仓库名'),
      sha: z.string().describe('commit 的 SHA（完整或前几位都行）'),
    },
    async ({ owner: o, repo, sha }) => {
      const own = owner(o);
      const c = await gh(`/repos/${own}/${repo}/commits/${sha}`);
      const result = {
        sha: c.sha,
        message: c.commit.message,
        author: c.commit.author?.name,
        date: c.commit.author?.date,
        stats: c.stats,
        url: c.html_url,
        files: (c.files || []).map((f) => ({
          filename: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          patch: f.patch,
        })),
      };
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ─── compare_commits ───
  server.tool(
    'compare_commits', '对比两个 commit/分支/tag 之间的差异',
    {
      owner: z.string().optional().describe('仓库所有者'),
      repo: z.string().describe('仓库名'),
      base: z.string().describe('对比基准，如 main 或某个 commit sha'),
      head: z.string().describe('对比目标，如某个分支名或 commit sha'),
    },
    async ({ owner: o, repo, base, head }) => {
      const own = owner(o);
      const c = await gh(`/repos/${own}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`);
      const result = {
        status: c.status,
        ahead_by: c.ahead_by,
        behind_by: c.behind_by,
        total_commits: c.total_commits,
        commits: (c.commits || []).map((cm) => ({ sha: cm.sha, message: cm.commit.message, author: cm.commit.author?.name })),
        files: (c.files || []).map((f) => ({
          filename: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          patch: f.patch,
        })),
      };
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ─── create_branch ───
  server.tool(
    'create_branch', '基于某个已有分支创建一个新分支',
    {
      owner: z.string().optional().describe('仓库所有者'),
      repo: z.string().describe('仓库名'),
      branch_name: z.string().describe('新分支名'),
      from_branch: z.string().optional().describe('基于哪个分支创建，默认 main'),
    },
    async ({ owner: o, repo, branch_name, from_branch }) => {
      const own = owner(o);
      const ref = await gh(`/repos/${own}/${repo}/git/ref/heads/${from_branch || 'main'}`);
      const newRef = await gh(`/repos/${own}/${repo}/git/refs`, {
        method: 'POST',
        body: JSON.stringify({ ref: `refs/heads/${branch_name}`, sha: ref.object.sha }),
      });
      return { content: [{ type: 'text', text: JSON.stringify({ branch: branch_name, from: from_branch || 'main', sha: newRef.object.sha }, null, 2) }] };
    }
  );

  // ─── list_branches ───
  server.tool(
    'list_branches', '列出仓库所有分支',
    {
      owner: z.string().optional().describe('仓库所有者'),
      repo: z.string().describe('仓库名'),
      per_page: z.number().optional().describe('每页数量，默认 30'),
      page: z.number().optional().describe('页码，默认 1'),
    },
    async ({ owner: o, repo, per_page, page }) => {
      const own = owner(o);
      const branches = await gh(`/repos/${own}/${repo}/branches?per_page=${per_page || 30}&page=${page || 1}`);
      const list = branches.map((b) => ({ name: b.name, sha: b.commit?.sha, protected: b.protected }));
      return { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }] };
    }
  );

  // ─── delete_branch ───
  server.tool(
    'delete_branch', '删除一个分支',
    {
      owner: z.string().optional().describe('仓库所有者'),
      repo: z.string().describe('仓库名'),
      branch: z.string().describe('要删除的分支名'),
    },
    async ({ owner: o, repo, branch }) => {
      const own = owner(o);
      if (branch === 'main' || branch === 'master') {
        return { content: [{ type: 'text', text: `❌ 拒绝删除 ${branch}，这看起来是主分支，如果确实要删请直接用 GitHub 网页操作` }] };
      }
      await gh(`/repos/${own}/${repo}/git/refs/heads/${branch}`, { method: 'DELETE' });
      return { content: [{ type: 'text', text: `✅ 已删除分支 ${own}/${repo}:${branch}` }] };
    }
  );

  // ─── create_pull_request ───
  server.tool(
    'create_pull_request', '创建一个 Pull Request',
    {
      owner: z.string().optional().describe('仓库所有者'),
      repo: z.string().describe('仓库名'),
      title: z.string().describe('PR 标题'),
      head: z.string().describe('来源分支名'),
      base: z.string().optional().describe('目标分支，默认 main'),
      body: z.string().optional().describe('PR 描述'),
    },
    async ({ owner: o, repo, title, head, base, body }) => {
      const own = owner(o);
      const pr = await gh(`/repos/${own}/${repo}/pulls`, {
        method: 'POST',
        body: JSON.stringify({ title, head, base: base || 'main', body: body || '' }),
      });
      return { content: [{ type: 'text', text: JSON.stringify({ number: pr.number, url: pr.html_url, state: pr.state }, null, 2) }] };
    }
  );

  // ─── merge_pull_request ───
  server.tool(
    'merge_pull_request', '合并一个 Pull Request',
    {
      owner: z.string().optional().describe('仓库所有者'),
      repo: z.string().describe('仓库名'),
      pull_number: z.number().describe('PR 编号'),
      commit_message: z.string().optional().describe('合并提交信息'),
      merge_method: z.enum(['merge', 'squash', 'rebase']).optional().describe('合并方式，默认 merge'),
    },
    async ({ owner: o, repo, pull_number, commit_message, merge_method }) => {
      const own = owner(o);
      const result = await gh(`/repos/${own}/${repo}/pulls/${pull_number}/merge`, {
        method: 'PUT',
        body: JSON.stringify({ commit_message: commit_message || '', merge_method: merge_method || 'merge' }),
      });
      return { content: [{ type: 'text', text: JSON.stringify({ merged: result.merged, sha: result.sha, message: result.message }, null, 2) }] };
    }
  );

  // ─── list_pull_requests ───
  server.tool(
    'list_pull_requests', '列出仓库的 Pull Request',
    {
      owner: z.string().optional().describe('仓库所有者'),
      repo: z.string().describe('仓库名'),
      state: z.enum(['open', 'closed', 'all']).optional().describe('状态，默认 open'),
      per_page: z.number().optional().describe('每页数量，默认 30'),
      page: z.number().optional().describe('页码，默认 1'),
    },
    async ({ owner: o, repo, state, per_page, page }) => {
      const own = owner(o);
      const prs = await gh(`/repos/${own}/${repo}/pulls?state=${state || 'open'}&per_page=${per_page || 30}&page=${page || 1}`);
      const list = prs.map((pr) => ({ number: pr.number, title: pr.title, state: pr.state, head: pr.head?.ref, base: pr.base?.ref, url: pr.html_url }));
      return { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }] };
    }
  );

  // ─── update_repo ───
  server.tool(
    'update_repo', '修改仓库设置（名称/描述/可见性/默认分支）',
    {
      owner: z.string().optional().describe('仓库所有者'),
      repo: z.string().describe('当前仓库名'),
      name: z.string().optional().describe('新仓库名（会改变仓库 URL，谨慎使用）'),
      description: z.string().optional().describe('新描述'),
      is_private: z.boolean().optional().describe('是否私有'),
      default_branch: z.string().optional().describe('新的默认分支'),
    },
    async ({ owner: o, repo, name, description, is_private, default_branch }) => {
      const own = owner(o);
      const body = {};
      if (name !== undefined) body.name = name;
      if (description !== undefined) body.description = description;
      if (is_private !== undefined) body.private = is_private;
      if (default_branch !== undefined) body.default_branch = default_branch;
      if (Object.keys(body).length === 0) {
        return { content: [{ type: 'text', text: '❌ 没有传入任何要修改的字段' }] };
      }
      const updated = await gh(`/repos/${own}/${repo}`, { method: 'PATCH', body: JSON.stringify(body) });
      return { content: [{ type: 'text', text: JSON.stringify({ full_name: updated.full_name, description: updated.description, private: updated.private, default_branch: updated.default_branch, url: updated.html_url }, null, 2) }] };
    }
  );

  return server;
}

const app = express();

app.use((req, res, next) => {
  console.log(`[请求到达] ${req.method} ${req.url}`);
  next();
});

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const jsonParser = express.json();

app.post('/mcp', jsonParser, async (req, res) => {
  try {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('MCP request error:', err);
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
  }
});

app.get('/mcp', (req, res) => res.status(405).end());
app.delete('/mcp', (req, res) => res.status(405).end());

const sseSessions = new Map();

app.get('/sse', async (req, res) => {
  try {
    const server = createServer();
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const messageEndpoint = `${protocol}://${req.get('host')}/messages`;
    const transport = new SSEServerTransport(messageEndpoint, res);
    sseSessions.set(transport.sessionId, { transport, server });
    res.on('close', () => { sseSessions.delete(transport.sessionId); server.close(); });
    await server.connect(transport);
  } catch (err) {
    console.error('SSE connection error:', err);
    if (!res.headersSent) res.status(500).end();
  }
});

app.post('/messages', async (req, res) => {
  try {
    const sessionId = req.query.sessionId;
    const session = sseSessions.get(sessionId);
    if (session) await session.transport.handlePostMessage(req, res);
    else res.status(400).json({ error: 'Unknown session' });
  } catch (err) {
    console.error('[Messages] 处理 POST 请求失败:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok', version: '1.3.0', owner: GITHUB_OWNER }));

app.listen(PORT, () => {
  console.log(`✅ GitHub MCP v1.3.0 running on port ${PORT}`);
  console.log(`   Tools: create_repo, list_repos, push_files, patch_file, get_file, list_files, delete_files, delete_repo, list_commits, get_commit, compare_commits, create_branch, list_branches, delete_branch, create_pull_request, merge_pull_request, list_pull_requests, update_repo`);
});

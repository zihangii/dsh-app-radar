/**
 * 应用雷达 · Host 半边
 *
 * 解决的问题：DSH 帮你改代码、跑项目时，常常在后台留下 `npm run dev` / `vite` /
 * `python -m http.server` 之类的长期进程。时间一长，端口占了一堆，没人说得清
 * 哪些是 DSH 启动的、跑了多久、还能不能停。
 *
 * 本文件提供三件事：
 *   1) 进程扫描与溯源：ps 拿全量进程表，lsof 拿监听端口与 cwd，再用「父进程链」
 *      + 「DSH_SESSION_ID 环境变量」判断这个进程是不是 DSH 启动的。
 *   2) 强制停止：先 TERM 整个进程组，900ms 后仍在就 KILL。带一串防止误杀 DSH
 *      自己和系统进程的护栏。
 *   3) 同源 HTTP 接口（/app-radar/api）+ 一个给模型用的 `app_radar` 工具，两者
 *      走同一份核心实现，UI 和工具的行为完全一致。
 *
 * 产品思路参考 laogou717/local-ops（MIT）：集中管理本地服务、启动者溯源、
 * 停止前的多重校验。代码为独立实现，未复制其源码，详见 CREDITS.md。
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { userInfo } from 'node:os'

const exec = promisify(execFile)
const API_PREFIX = '/app-radar/api'
const SCAN_TTL_MS = 1200          // 同一轮扫描复用时长，避免 UI 轮询把机器打满
const KILL_GRACE_MS = 900         // TERM 之后等多久升级到 KILL
const LONG_RUNNING_MS = 8_000     // 无端口进程至少活这么久才值得出现在雷达上

const PS_CMD = 'ps'
const LSOF = ['/usr/sbin/lsof', '/usr/bin/lsof'].find((p) => existsSync(p)) || 'lsof'
const KILL_BIN = existsSync('/bin/kill') ? '/bin/kill' : 'kill'

const isDarwin = process.platform === 'darwin'

/** ps -o 的字段顺序（带 stat 与不带 stat 两种） */
const RE_PS_FULL = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(\S+)\s+(.*)$/
const RE_PS_NOSTAT = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(.*)$/

const psCache = new Map()   // cwd -> 项目名，避免每轮重复读 package.json

// ── 小工具 ────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function sh(bin, args, timeout = 6000) {
  const { stdout } = await exec(bin, args, { timeout, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' })
  return stdout
}

/** 进程随时可能消失，lsof 遇到已退出的 pid 会以非零码退出但 stdout 仍然有效 */
async function shSoft(bin, args, timeout = 6000) {
  try {
    return await sh(bin, args, timeout)
  } catch (error) {
    const stdout = error && typeof error.stdout === 'string' ? error.stdout : ''
    return stdout || null
  }
}

/** 解析 etime：`mm:ss` / `hh:mm:ss` / `dd-hh:mm:ss` */
function etimeToSeconds(raw) {
  if (!raw) return 0
  let days = 0
  let rest = String(raw)
  const dash = rest.indexOf('-')
  if (dash > 0) {
    days = Number(rest.slice(0, dash)) || 0
    rest = rest.slice(dash + 1)
  }
  const parts = rest.split(':').map((n) => Number(n) || 0)
  const [h, m, s] = parts.length === 3 ? parts : parts.length === 2 ? [0, parts[0], parts[1]] : [0, 0, parts[0] || 0]
  return days * 86400 + h * 3600 + m * 60 + s
}

function humanDuration(seconds) {
  const s = Math.max(0, Math.round(seconds || 0))
  if (s < 60) return `${s} 秒`
  if (s < 3600) return `${Math.floor(s / 60)} 分钟`
  if (s < 86400) return `${Math.floor(s / 3600)} 小时 ${Math.floor((s % 3600) / 60)} 分`
  return `${Math.floor(s / 86400)} 天 ${Math.floor((s % 86400) / 3600)} 小时`
}

function isDshAppCommand(command) {
  if (!command) return true
  return /DSH NEXT\.app\/Contents\/(MacOS|Frameworks|Resources)/.test(command)
}

function isHelperCommand(command) {
  const head = String(command || '').trim().split(/\s+/)[0] || ''
  const name = basename(head)
  return name === 'ps' || name === 'lsof' || name === 'kill' || name === 'pgrep' || name === 'awk'
}

/** 端口名 `*:7000` / `127.0.0.1:5173` / `[::1]:8080` → 端口号 */
function portOf(name) {
  if (!name) return null
  const idx = name.lastIndexOf(':')
  if (idx < 0) return null
  const n = Number(name.slice(idx + 1))
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null
}

// ── 进程表 ────────────────────────────────────────────────────────────────────

/**
 * 读全量进程表。macOS 上 `ps` 是 setuid root，在某些沙箱里会被拒绝执行，
 * 所以这里准备了两档：完整字段 → 无 stat 字段 → 失败返回 null 由调用方降级。
 */
async function readProcessTable() {
  const full = 'pid=,ppid=,pgid=,user=,rss=,pcpu=,etime=,stat=,command='
  const noStat = 'pid=,ppid=,pgid=,user=,rss=,pcpu=,etime=,command='
  const attempts = [
    { args: ['-Aww', '-o', full], re: RE_PS_FULL },
    { args: ['-Aww', '-o', noStat], re: RE_PS_NOSTAT },
    { args: ['-Aw', '-o', noStat], re: RE_PS_NOSTAT },
  ]
  for (const attempt of attempts) {
    const re = attempt.re
    let out
    try {
      out = await sh(PS_CMD, attempt.args)
    } catch {
      continue
    }
    const rows = []
    for (const line of out.split('\n')) {
      if (!line.trim()) continue
      const m = re.exec(line)
      if (!m) continue
      const withStat = re === RE_PS_FULL
      rows.push({
        pid: Number(m[1]),
        ppid: Number(m[2]),
        pgid: Number(m[3]),
        user: m[4],
        rssKB: Number(m[5]) || 0,
        cpu: Number(m[6]) || 0,
        etime: m[7],
        stat: withStat ? m[8] : '',
        command: (withStat ? m[9] : m[8]) || '',
      })
    }
    if (rows.length) return rows
  }
  return null
}

/**
 * 监听中的 TCP 端口。lsof 顺便给出 pgid/ppid/uid/命令名，所以即使 ps 不可用，
 * 端口这一半信息仍然完整、仍然能安全地停进程。
 */
async function readListeners() {
  const out = await shSoft(LSOF, ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcgRuLn'])
  if (!out) return { ok: false, byPid: new Map() }
  const byPid = new Map()
  let cur = null
  for (const line of out.split('\n')) {
    if (!line) continue
    const tag = line[0]
    const value = line.slice(1)
    if (tag === 'p') {
      const pid = Number(value) || 0
      if (!pid) { cur = null; continue }
      cur = byPid.get(pid)
      if (!cur) {
        cur = { pid, command: '', pgid: null, ppid: null, uid: null, user: '', ports: new Set() }
        byPid.set(pid, cur)
      }
    } else if (!cur) {
      continue
    } else if (tag === 'c') {
      cur.command = value
    } else if (tag === 'g') {
      cur.pgid = Number(value) || null
    } else if (tag === 'R') {
      cur.ppid = Number(value) || null
    } else if (tag === 'u') {
      cur.uid = Number(value)
    } else if (tag === 'L') {
      cur.user = value
    } else if (tag === 'n') {
      const port = portOf(value)
      if (port) cur.ports.add(port)
    }
  }
  return { ok: true, byPid }
}

/** ps 不可用时的兜底：用 lsof 拿自己的进程组 */
async function readSelfGroup(pid) {
  try {
    const out = await sh(LSOF, ['-a', '-p', String(pid), '-F', 'g'])
    const m = /^g(\d+)$/m.exec(out)
    return m ? Number(m[1]) : null
  } catch {
    return null
  }
}

/** ps 不可用时的兜底：顺着 lsof 的父进程字段往上走，拿到自己的祖先链 */
async function readAncestorsWithoutPs(pid) {
  const seen = new Set([1])
  let cursor = pid
  for (let i = 0; i < 8; i += 1) {
    let ppid = null
    try {
      const out = await sh(LSOF, ['-a', '-p', String(cursor), '-F', 'R'])
      const m = /^R(\d+)$/m.exec(out)
      if (m) ppid = Number(m[1])
    } catch { /* 拿不到就停在这一层 */ }
    if (!ppid || ppid <= 1 || seen.has(ppid)) break
    seen.add(ppid)
    cursor = ppid
  }
  return seen
}

/** 一批 pid 的工作目录：pid → cwd（一次 lsof 调用搞定） */
async function readCwds(pids) {
  const out = new Map()
  if (!pids.length) return out
  const text = await shSoft(LSOF, ['-a', '-d', 'cwd', '-F', 'pn', '-p', pids.join(',')])
  if (!text) return out
  let cur = 0
  for (const line of text.split('\n')) {
    if (!line) continue
    if (line[0] === 'p') cur = Number(line.slice(1)) || 0
    else if (line[0] === 'n' && cur) out.set(cur, line.slice(1))
  }
  return out
}

/**
 * 只看这批 pid 的环境变量里有没有 DSH 的标记。
 * 注意：ps -E 会带出全部环境变量（可能含密钥），这里只做一次正则判断，
 * 匹配结果之外的任何内容都不会离开函数，更不会进日志或响应体。
 */
async function readDshEnv(pids) {
  if (!isDarwin || !pids.length) return new Map()
  const wanted = new Set(pids)
  const attempts = [
    ['-ww', '-E', '-o', 'pid=,command=', '-p', pids.slice(0, 200).join(',')],
    ['-Aww', '-E', '-o', 'pid=,command='],
  ]
  for (const args of attempts) {
    let out
    try {
      out = await sh(PS_CMD, args)
    } catch {
      continue
    }
    const hit = new Map()
    for (const line of out.split('\n')) {
      const m = /^\s*(\d+)\s/.exec(line)
      if (!m) continue
      const pid = Number(m[1])
      if (!wanted.has(pid)) continue
      const session = /DSH_SESSION_ID=([A-Za-z0-9_-]+)/.exec(line)
      const shell = /\bDSH_SHELL=1\b/.test(line)
      if (session) hit.set(pid, { session: session[1] })
      else if (shell) hit.set(pid, { session: null })
    }
    // 这一次调用是成功的：没有命中就说明这批进程确实没有 DSH 标记
    return hit
  }
  return new Map()
}

// ── 项目标签 ──────────────────────────────────────────────────────────────────

function projectLabel(cwd) {
  if (!cwd || cwd === '/') return null
  if (psCache.has(cwd)) return psCache.get(cwd)
  // 系统目录 / 应用数据目录不是「项目」，交给命令名去说明
  const noisy = [/^\/System\//, /^\/usr\//, /^\/private\//, /^\/Library\//, /\/Library\/Application Support\//, /\/Library\/Containers\//]
  if (noisy.some((re) => re.test(cwd))) {
    psCache.set(cwd, null)
    return null
  }
  let label = null
  let dir = cwd
  for (let i = 0; i < 4; i += 1) {
    if (!dir || dir === '/' || dir === userInfo().homedir) break
    const pkgPath = join(dir, 'package.json')
    if (existsSync(pkgPath)) {
      try {
        const name = JSON.parse(readFileSync(pkgPath, 'utf8')).name
        if (name && typeof name === 'string') label = name
      } catch { /* package.json 坏了就退回目录名 */ }
      label = label || basename(dir)
      break
    }
    if (existsSync(join(dir, '.git')) || existsSync(join(dir, 'pyproject.toml')) || existsSync(join(dir, 'go.mod')) || existsSync(join(dir, 'Cargo.toml'))) {
      label = basename(dir)
      break
    }
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  label = label || basename(cwd) || null
  if (psCache.size > 500) psCache.clear()
  psCache.set(cwd, label)
  return label
}

/** 列表里那一列「项目」：有项目名就用项目名，否则退回可执行文件名 */
function rowLabel(project, command, pid) {
  if (project) return project
  const first = String(command || '').trim().split(/\s+/)[0]
  const name = first ? basename(first) : ''
  return name || `pid ${pid}`
}

// ── 一轮扫描 ──────────────────────────────────────────────────────────────────

function createScanner() {
  let cached = null
  let cachedAt = 0
  let inflight = null
  let lastOkAt = 0

  async function scanNow() {
    const warnings = []
    const startedAt = Date.now()
    const ownPid = process.pid
    const uid = typeof process.getuid === 'function' ? process.getuid() : null
    const me = (() => { try { return userInfo().username } catch { return '' } })()

    const table = await readProcessTable()
    const listeners = await readListeners()
    if (!listeners.ok) warnings.push('lsof 读取监听端口失败，端口信息可能为空')
    if (!table) warnings.push('ps 读取进程表失败（被系统限制），只显示端口信息：没有运行时长和内存，也无法识别哪些进程由 DSH 启动')

    const byPid = new Map()
    if (table) for (const row of table) byPid.set(row.pid, row)

    // 自己的祖先链：这些 pid 一律不许停、也不进列表
    const ancestors = new Set()
    if (table) {
      let cursor = byPid.get(ownPid)
      const seen = new Set([ownPid])
      while (cursor && cursor.ppid > 1 && !seen.has(cursor.ppid)) {
        seen.add(cursor.ppid)
        ancestors.add(cursor.ppid)
        cursor = byPid.get(cursor.ppid)
      }
      if (!cursor) ancestors.add(1)
    } else {
      // 进程表不可用时用 lsof 一步一步往上问，至少别把自己和父进程列进去
      for (const pid of await readAncestorsWithoutPs(ownPid)) ancestors.add(pid)
      ancestors.add(1)
    }

    // 子进程索引，用来从 DSH 自己往下找
    const childrenOf = new Map()
    if (table) {
      for (const row of table) {
        if (!childrenOf.has(row.ppid)) childrenOf.set(row.ppid, [])
        childrenOf.get(row.ppid).push(row.pid)
      }
    }
    const descendants = new Set()
    if (table) {
      const stack = [ownPid]
      while (stack.length) {
        const pid = stack.pop()
        for (const child of childrenOf.get(pid) || []) {
          if (descendants.has(child)) continue
          descendants.add(child)
          stack.push(child)
        }
      }
    }

    // 候选：所有监听者 + DSH 的所有后代（后者再按存活时间过滤）
    const listenPids = [...listeners.byPid.keys()]
    const candidates = new Set([...listenPids, ...descendants])
    for (const pid of [...candidates]) {
      if (pid === ownPid || pid <= 1 || ancestors.has(pid)) candidates.delete(pid)
    }

    const candidateList = [...candidates]
    const [cwds, dshEnv] = await Promise.all([
      readCwds(candidateList),
      readDshEnv(candidateList),
    ])

    const ownGroup = byPid.get(ownPid)?.pgid ?? (table ? null : await readSelfGroup(ownPid))
    const groupPids = new Map()
    if (table) {
      for (const row of table) {
        if (!groupPids.has(row.pgid)) groupPids.set(row.pgid, [])
        groupPids.get(row.pgid).push(row.pid)
      }
    }

    const rows = []
    for (const pid of candidateList) {
      const proc = byPid.get(pid)
      const info = listeners.byPid.get(pid)
      const ports = info ? [...info.ports].sort((a, b) => a - b) : []
      const listening = ports.length > 0
      const envHit = dshEnv.get(pid)
      const isDescendant = descendants.has(pid)
      const origin = envHit || isDescendant ? 'dsh' : 'external'
      const cwd = cwds.get(pid) || null

      // ps 不可用时的降级行：端口、pid、pgid、uid 都来自 lsof，仍然可以安全地停
      if (!proc) {
        if (!listening || !info) continue
        if (ancestors.has(pid) || pid === ownPid) continue
        const sameUser = uid === null || info.uid === null || info.uid === uid
        const groupSafe = Boolean(info.pgid && info.pgid > 1 && info.pgid !== ownGroup)
        rows.push({
          id: `pid:${pid}`,
          pid,
          ppid: info.ppid,
          pgid: info.pgid,
          user: info.user,
          ports,
          listening: true,
          command: info.command || '',
          cwd,
          project: projectLabel(cwd),
          label: rowLabel(projectLabel(cwd), info.command, pid),
          origin,
          session: envHit?.session ? envHit.session.replace(/^session-/, '') : null,
          etime: '',
          etimeSeconds: 0,
          etimeText: '—',
          rssMB: 0,
          cpu: 0,
          state: '',
          groupKill: groupSafe,
          killable: sameUser,
          guard: sameUser ? null : '不是当前用户的进程',
          degraded: true,
        })
        continue
      }

      if (isHelperCommand(proc.command)) continue
      if (isDshAppCommand(proc.command)) continue
      if (ancestors.has(pid) || pid === ownPid) continue

      const seconds = etimeToSeconds(proc.etime)
      // 无端口的进程只在 DSH 启动 + 活得够久时才展示，免得列表里全是转瞬即逝的 shell
      if (!listening && !(origin === 'dsh' && seconds >= LONG_RUNNING_MS / 1000)) continue

      const sameUser = uid === null || proc.user === me || proc.user === String(uid)
      const groupMembers = groupPids.get(proc.pgid) || []
      const groupDangerous = proc.pgid <= 1
        || proc.pgid === ownGroup
        || groupMembers.some((p) => p === ownPid || ancestors.has(p))

      let guard = null
      if (!sameUser) guard = '不是当前用户的进程'
      else if (proc.pid === ownPid) guard = '不能停止 DSH 自身'
      else if (ancestors.has(proc.pid)) guard = '不能停止 DSH 的父进程'
      else if (isDshAppCommand(proc.command)) guard = '不能停止 DSH 应用本体'

      rows.push({
        id: `pid:${proc.pid}`,
        pid: proc.pid,
        ppid: proc.ppid,
        pgid: proc.pgid,
        user: proc.user,
        ports,
        listening,
        command: proc.command,
        cwd,
        project: projectLabel(cwd),
        label: rowLabel(projectLabel(cwd), proc.command, proc.pid),
        origin,
        session: envHit?.session ? envHit.session.replace(/^session-/, '') : null,
        etime: proc.etime,
        etimeSeconds: seconds,
        etimeText: humanDuration(seconds),
        rssMB: Math.round((proc.rssKB / 1024) * 10) / 10,
        cpu: Math.round(proc.cpu * 10) / 10,
        state: proc.stat,
        groupKill: !groupDangerous && proc.pgid > 1,
        killable: !guard,
        guard,
      })
    }

    rows.sort((a, b) => {
      if (a.origin !== b.origin) return a.origin === 'dsh' ? -1 : 1
      const ap = a.ports[0] ?? 0
      const bp = b.ports[0] ?? 0
      if (ap !== bp) return ap - bp
      return b.etimeSeconds - a.etimeSeconds
    })

    // 归属：把每个进程挂到「宿主进程的某个直接子进程」下，形成一棵启动树。
    // 一条 `pnpm dev` 会经由 turbo 给每个包开独立进程组，但父子链始终连着；
    // 按树归并才是用户心里的「一个项目」，而不是一屏 helper 进程。
    const treeRootOf = (pid) => {
      let cur = pid
      for (let i = 0; i < 64; i += 1) {
        const proc = byPid.get(cur)
        if (!proc) return cur
        if (proc.ppid === ownPid) return cur
        const parent = byPid.get(proc.ppid)
        if (!parent || parent.pid === cur) return cur
        cur = parent.pid
      }
      return cur
    }
    for (const row of rows) row.treeId = `tree:${treeRootOf(row.pid)}`

    // 整棵树的全部进程（含没显示出来的 shell / turbo 包装进程）：
    // 停整棵树时必须连它们一起收，否则 shell 会留在后台，树也就没真停掉。
    const treeMembers = new Map()
    if (table) {
      for (const proc of byPid.values()) {
        const pid = proc.pid
        if (pid === ownPid || pid <= 1 || ancestors.has(pid)) continue
        const root = treeRootOf(pid)
        if (!treeMembers.has(root)) treeMembers.set(root, [])
        treeMembers.get(root).push(pid)
      }
    }

    const byTree = new Map()
    for (const row of rows) {
      if (!byTree.has(row.treeId)) byTree.set(row.treeId, [])
      byTree.get(row.treeId).push(row)
    }
    const groups = []
    for (const [treeId, members] of byTree) {
      const memberPids = new Set(members.map((m) => m.pid))
      const heads = members.filter((m) => !memberPids.has(m.ppid))
      const head = (heads.length ? heads : members).slice().sort((a, b) => b.etimeSeconds - a.etimeSeconds)[0]
      const ports = [...new Set(members.flatMap((m) => m.ports))].sort((a, b) => a - b)
      const blocking = members.find((m) => !m.killable)
      const origin = members.some((m) => m.origin === 'dsh') ? 'dsh' : 'external'
      groups.push({
        id: treeId,
        treeId,
        rootPid: head.pid,
        label: head.project || head.label,
        project: head.project,
        command: head.command,
        cwd: head.cwd || null,
        origin,
        ports,
        listening: ports.length > 0,
        procCount: members.length,
        memberPids: [...memberPids],
        allPids: (treeMembers.get(Number(treeId.slice('tree:'.length))) || [...memberPids]).sort((a, b) => a - b),
        rssMB: Math.round(members.reduce((n, m) => n + m.rssMB, 0) * 10) / 10,
        cpu: Math.round(members.reduce((n, m) => n + m.cpu, 0) * 10) / 10,
        etimeSeconds: head.etimeSeconds,
        etimeText: head.etimeText,
        killable: !blocking,
        guard: blocking ? blocking.guard : null,
      })
    }
    groups.sort((a, b) => {
      if (a.origin !== b.origin) return a.origin === 'dsh' ? -1 : 1
      const ap = a.ports[0] ?? 0
      const bp = b.ports[0] ?? 0
      if (ap !== bp) return ap - bp
      return b.procCount - a.procCount
    })

    const dshRows = rows.filter((r) => r.origin === 'dsh')
    const snapshot = {
      ok: true,
      generatedAt: new Date().toISOString(),
      scanMs: Date.now() - startedAt,
      degraded: !table,
      platform: process.platform,
      host: {
        pid: ownPid,
        uid,
        user: me,
        cwd: (() => { try { return process.cwd() } catch { return null } })(),
      },
      rows,
      groups,
      summary: {
        total: rows.length,
        dsh: dshRows.length,
        external: rows.length - dshRows.length,
        groups: groups.length,
        dshGroups: groups.filter((g) => g.origin === 'dsh').length,
        ports: groups.reduce((n, g) => n + g.ports.length, 0),
        rssMB: Math.round(rows.reduce((n, r) => n + r.rssMB, 0)),
      },
      warnings,
    }
    lastOkAt = Date.now()
    return snapshot
  }

  return {
    lastOkAt: () => lastOkAt,
    async scan(force = false) {
      const now = Date.now()
      if (!force && cached && now - cachedAt < SCAN_TTL_MS) return cached
      if (inflight) return inflight
      inflight = scanNow()
        .then((snap) => { cached = snap; cachedAt = Date.now(); return snap })
        .finally(() => { inflight = null })
      return inflight
    },
    invalidate() { cached = null; cachedAt = 0 },
  }
}

// ── 强制停止 ──────────────────────────────────────────────────────────────────

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error && error.code === 'EPERM'
  }
}

function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    return error && error.code === 'EPERM'
  }
}

/**
 * 停一个目标：优先停整个进程组（`npm run dev` 这类会带出一串子进程），
 * 进程组不安全时退回单进程。
 */
async function stopTarget(scanner, { pid, force = false, group } = {}) {
  const target = Number(pid)
  if (!Number.isInteger(target) || target <= 1) return { ok: false, message: '无效的 pid' }

  const snapshot = await scanner.scan(true)
  const row = snapshot.rows.find((r) => r.pid === target)
  if (!row) return { ok: false, message: '这个进程已经不在雷达里了（可能已经退出）' }
  if (row.guard) return { ok: false, message: row.guard }

  const useGroup = group === undefined ? row.groupKill : Boolean(group) && row.groupKill
  const signalTarget = useGroup ? `-${row.pgid}` : String(row.pid)
  const steps = []

  try {
    await exec(KILL_BIN, [force ? '-KILL' : '-TERM', signalTarget], { timeout: 4000 })
    steps.push({ signal: force ? 'SIGKILL' : 'SIGTERM', target: signalTarget, at: new Date().toISOString() })
  } catch (error) {
    // 进程刚好在这一刻退出，kill 会返回 ESRCH；这算成功
    if (!/No such process|ESRCH/i.test(String(error?.stderr || error?.message || ''))) {
      return { ok: false, message: `发送信号失败：${error?.message || error}`, steps }
    }
  }

  const stillAlive = () => (useGroup ? groupAlive(row.pgid) : alive(row.pid))

  if (force) {
    await sleep(150)
    scanner.invalidate()
    return {
      ok: true,
      message: stillAlive() ? '已发送 SIGKILL，但进程仍未退出' : `已强制终止 ${row.label || '进程'}（pid ${row.pid}${useGroup ? `，进程组 ${row.pgid}` : ''}）`,
      killed: [row.pid],
      group: useGroup ? row.pgid : null,
      steps,
    }
  }

  const deadline = Date.now() + KILL_GRACE_MS
  while (Date.now() < deadline) {
    if (!stillAlive()) break
    await sleep(120)
  }

  if (stillAlive()) {
    return {
      ok: false,
      needsForce: true,
      message: `${row.label || '进程'} 没有响应 SIGTERM，仍然活着。可以用「强制终止」升级为 SIGKILL。`,
      pid: row.pid,
      steps,
    }
  }

  scanner.invalidate()
  return {
    ok: true,
    message: `已停止 ${row.label || '进程'}（pid ${row.pid}${useGroup ? `，进程组 ${row.pgid}` : ''}）`,
    killed: [row.pid],
    group: useGroup ? row.pgid : null,
    steps,
  }
}

/**
 * 停一整棵启动树：逐个成员发信号，**不做进程组升级**。
 * 一条命令拉起的进程可能横跨好几个进程组（turbo 就是这么干的），
 * 按 pid 精确收敛才不会连带停掉同一进程组里别的命令。
 */
async function stopTree(scanner, { treeId, force = false } = {}) {
  if (!treeId) return { ok: false, message: '缺少 treeId' }
  const snapshot = await scanner.scan(true)
  const group = (snapshot.groups || []).find((g) => g.treeId === treeId)
  const members = snapshot.rows.filter((r) => r.treeId === treeId)
  if (!group && !members.length) return { ok: false, message: '这棵启动树已经不在雷达里了（可能已经退出）' }
  const blocking = members.find((m) => !m.killable)
  if (blocking) return { ok: false, message: blocking.guard }

  const head = group || members.slice().sort((a, b) => b.etimeSeconds - a.etimeSeconds)[0]
  // 连没显示出来的包装进程一起停：只停看得见的那几个，shell 会留在后台
  const pids = ((group && group.allPids && group.allPids.length) ? group.allPids : members.map((m) => m.pid)).slice()
  const signal = force ? '-KILL' : '-TERM'
  const steps = []
  // 深的先停：父进程先走会让子进程被换父，后面按 pid 就找不到了
  for (const pid of pids.sort((a, b) => b - a)) {
    try {
      await exec(KILL_BIN, [signal, String(pid)], { timeout: 3000 })
      steps.push({ signal: force ? 'SIGKILL' : 'SIGTERM', target: String(pid) })
    } catch (error) {
      if (!/No such process|ESRCH/i.test(String(error?.stderr || error?.message || ''))) {
        return { ok: false, message: `发送信号失败（pid ${pid}）：${error?.message || error}`, steps }
      }
    }
  }

  const survivors = () => pids.filter((pid) => alive(pid))
  if (!force) {
    const deadline = Date.now() + KILL_GRACE_MS
    while (Date.now() < deadline) {
      if (!survivors().length) break
      await sleep(120)
    }
    if (survivors().length) {
      return {
        ok: false,
        needsForce: true,
        treeId,
        steps,
        message: `${head.project || head.label || '启动树'} 里还有 ${survivors().length} 个进程没响应 SIGTERM，可以用「强制终止」升级为 SIGKILL。`,
      }
    }
  }

  scanner.invalidate()
  return {
    ok: true,
    treeId,
    steps,
    stopped: pids,
    message: `已停止 ${head.project || head.label || '启动树'} 的整棵启动树（${pids.length} 个进程）`,
  }
}

async function stopAllDsh(scanner, { force = false } = {}) {
  const snapshot = await scanner.scan(true)
  const trees = (snapshot.groups || []).filter((g) => g.origin === 'dsh' && g.killable)
  if (!trees.length) return { ok: true, message: '没有需要停止的进程', results: [] }

  const results = []
  let procs = 0
  for (const tree of trees) {
    const result = await stopTree(scanner, { treeId: tree.treeId, force })
    results.push({ treeId: tree.treeId, label: tree.label, ...result })
    if (result.ok) procs += ((tree.allPids && tree.allPids.length) || tree.memberPids || []).length
  }
  const killed = results.filter((r) => r.ok).length
  const failed = results.length - killed
  return {
    ok: failed === 0,
    message: `已停止 ${killed} 棵由 DSH 启动的启动树（${procs} 个进程）${failed ? `，${failed} 棵没停干净` : ''}`,
    results,
  }
}

// ── HTTP 接口 ─────────────────────────────────────────────────────────────────

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(body))
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体太大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch (error) { reject(error) }
    })
    req.on('error', reject)
  })
}

/** 只放行回环地址来的请求；带 Origin 时必须是回环源 */
function loopbackOnly(req) {
  const addr = req.socket?.remoteAddress || ''
  const remoteOk = addr === '' || addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
  if (!remoteOk) return false
  const origin = req.headers.origin
  if (!origin) return true
  try {
    const url = new URL(origin)
    const host = url.hostname
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
  } catch {
    return false
  }
}

async function dispatch(scanner, method, params) {
  switch (method) {
    case 'snapshot': {
      const snap = await scanner.scan(Boolean(params?.force))
      return { ok: true, ...snap }
    }
    case 'kill':
      return stopTarget(scanner, { pid: params?.pid, force: Boolean(params?.force) })
    case 'killTree':
      return stopTree(scanner, { treeId: params?.treeId, force: Boolean(params?.force) })
    case 'stopAll':
      return stopAllDsh(scanner, { force: Boolean(params?.force) })
    default:
      return { ok: false, message: `未知方法 "${method ?? ''}"（可用：snapshot、kill、killTree、stopAll）` }
  }
}

// ── 给模型的工具 ──────────────────────────────────────────────────────────────

function renderList(snap) {
  const groups = snap.groups || []
  if (!groups.length) {
    return '应用雷达：现在后台没有由 DSH 启动的长期进程。'
  }
  const lines = groups.map((g) => {
    const port = g.ports.length ? g.ports.map((p) => `:${p}`).join(' ') : '无端口'
    const procs = g.procCount > 1 ? `（${g.procCount} 个进程）` : ''
    return `- ${port}  ${g.label}${procs}  [${g.origin === 'dsh' ? 'DSH 启动' : '外部进程'}]  pid ${g.rootPid}  已运行 ${g.etimeText}  内存 ${g.rssMB}MB${g.killable ? '' : `  (不可停止：${g.guard})`}`
  })
  const sum = snap.summary
  return [
    `应用雷达：共 ${sum.groups} 棵启动树 / ${sum.total} 个后台进程（DSH 启动 ${sum.dshGroups} 棵 / ${sum.dsh} 个进程，占用 ${sum.ports} 个端口，合计 ${sum.rssMB}MB 内存）。`,
    ...lines,
  ].join('\n')
}

export const inject = ['webServer', 'tools']

export function apply(ctx) {
  const scanner = createScanner()

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    async handler(req, res) {
      if (!loopbackOnly(req)) {
        sendJson(res, 403, { ok: false, message: 'forbidden: 应用雷达只接受本机页面调用' })
        return
      }
      try {
        if (req.method === 'GET') {
          const snap = await scanner.scan(req.url?.includes('force=1'))
          sendJson(res, 200, { ok: true, ...snap })
          return
        }
        if (req.method !== 'POST') {
          res.writeHead(405, { allow: 'GET, POST' })
          res.end()
          return
        }
        const body = await readBody(req)
        const result = await dispatch(scanner, body?.method, body?.params)
        sendJson(res, 200, result)
      } catch (error) {
        ctx.logger?.warn?.(`app-radar api error: ${error?.message || error}`)
        sendJson(res, 500, { ok: false, message: String(error?.message || error) })
      }
    },
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'app_radar',
    description: '应用雷达：列出这台机器上由 DSH 启动的后台进程和它们占用的端口，并可以强制停止。'
      + '当用户在 DSH 里跑过 dev server、脚本或长期任务，想确认「后台到底还有什么在跑」或要收尾时用它。'
      + '一条命令拉起的进程树会归并成一棵「启动树」（monorepo 的 pnpm dev 常见：一个项目十几个进程）。'
      + 'action=list 查看，action=kill 停一个进程（pid）或整棵启动树（tree_id），action=stop_all 停掉所有由 DSH 启动的。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'kill', 'stop_all'],
          description: 'list 列举；kill 停止指定 pid；stop_all 停止所有由 DSH 启动的进程',
        },
        pid: { type: 'integer', description: 'action=kill 时要停止的单个进程 pid' },
        tree_id: {
          type: 'string',
          description: 'action=kill 时改为停一整棵启动树：用 list 结果里的 tree 标识（形如 tree:51234），会停掉该树下的所有进程',
        },
        force: { type: 'boolean', description: '直接发 SIGKILL，不先尝试 SIGTERM' },
      },
      required: ['action'],
    },
    timeoutMs: 30_000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          message: { type: 'string' },
        },
      },
      render(_args, value) {
        const text = value?.message && typeof value.message === 'string' ? value.message : ''
        return [{ type: 'text', text: text || '应用雷达已完成。' }]
      },
    },
    async execute(args) {
      const action = args?.action
      if (action === 'list') {
        const snap = await scanner.scan(Boolean(args?.force))
        const text = renderList(snap)
        return { ok: true, message: text, summary: snap.summary }
      }
      if (action === 'kill') {
        if (args?.tree_id) return stopTree(scanner, { treeId: args.tree_id, force: Boolean(args?.force) })
        return stopTarget(scanner, { pid: args?.pid, force: Boolean(args?.force) })
      }
      if (action === 'stop_all') {
        const result = await stopAllDsh(scanner, { force: Boolean(args?.force) })
        return result
      }
      return { ok: false, message: `未知 action "${action ?? ''}"（可用：list、kill、stop_all）` }
    },
  }))

  ctx.logger?.info?.('应用雷达已就绪：面板「应用雷达」，接口 /app-radar/api，工具 app_radar')
}

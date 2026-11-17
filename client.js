/**
 * 应用雷达 · 浏览器半边
 *
 * 侧栏加一个「应用雷达」入口，主区域是一整页的控制台：把 DSH 在后台启动的
 * 进程、它们占用的端口、跑了多久、吃了多少内存列成一张表，每一行都能强制停止。
 *
 * 数据来自 Host 半边的 POST /app-radar/api（同一个来源的页面才能调）。
 *
 * 产品思路参考 laogou717/local-ops（MIT），代码为独立实现，详见 CREDITS.md。
 */
window.__ModuleLoader__.load({
  // 必须与 package.json 的 name 一致：客户端模块表按包名索引 factory
  id: 'dsh-app-radar',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const PANEL = 'app-radar'
    const API = '/app-radar/api'
    const POLL_MS = 4000

    // ── 文案 ──────────────────────────────────────────────────────────────────
    const DICT = {
      zh: {
        title: '应用雷达',
        subtitle: 'DSH 在后台启动的进程和端口，都在这里',
        refresh: '刷新',
        auto: '自动刷新',
        scanning: '正在扫描…',
        empty: '后台很干净',
        emptyHint: '目前没有由 DSH 启动的长期进程。跑过 dev server 之后再来看一眼。',
        emptyAll: '没有任何监听端口',
        emptyAllHint: '这台机器上没有任何进程在监听 TCP 端口。',
        filterDsh: 'DSH 启动',
        filterAll: '全部进程',
        colPort: '端口',
        colProject: '项目 / 命令',
        colOrigin: '启动者',
        colUptime: '运行时长',
        colMemory: '内存',
        colAction: '操作',
        stop: '停止',
        dshOrigin: 'DSH',
        externalOrigin: '外部',
        stopAll: '全部停止',
        stopTree: '停止全部',
        expandHint: '展开这棵树里的进程',
        collapseHint: '收起',
        confirmTreeTitle: '停止整棵启动树？',
        confirmProcTitle: '强制停止这个进程？',
        procsSub: '个进程',
        treeNote: '会逐个进程停止（不做进程组升级），避免连带停掉同一进程组里的其他命令。',
        memberPid: '进程',
        stopAllTitle: '停止所有由 DSH 启动的进程',
        confirmTitle: '强制停止这个进程？',
        confirmKill: '停止',
        confirmForce: '强制终止 (SIGKILL)',
        cancel: '取消',
        statTotal: '个后台进程',
        statDsh: '个由 DSH 启动',
        statPorts: '个端口被占用',
        statMemory: 'MB 内存占用',
        scanningTip: '每 4 秒自动刷新一次',
        stoppedOk: '已停止',
        failed: '操作失败',
        noPort: '无端口',
        session: '会话',
        lastScan: '上次扫描',
        warn: '注意',
        killAllConfirm: '这会把所有由 DSH 启动的进程一起停掉（不影响 DSH 自身）。确定吗？',
      },
      en: {
        title: 'App Radar',
        subtitle: 'Every process and port DSH started in the background, in one place',
        refresh: 'Refresh',
        auto: 'Auto refresh',
        scanning: 'Scanning…',
        empty: 'Nothing running',
        emptyHint: 'No long-running process started by DSH right now. Come back after running a dev server.',
        emptyAll: 'No listening ports',
        emptyAllHint: 'No process on this machine is listening on a TCP port.',
        filterDsh: 'Started by DSH',
        filterAll: 'All processes',
        colPort: 'Port',
        colProject: 'Project / command',
        colOrigin: 'Started by',
        colUptime: 'Uptime',
        colMemory: 'Memory',
        colAction: 'Action',
        stop: 'Stop',
        dshOrigin: 'DSH',
        externalOrigin: 'external',
        stopAll: 'Stop all',
        stopTree: 'Stop tree',
        expandHint: 'Expand the processes in this tree',
        collapseHint: 'Collapse',
        confirmTreeTitle: 'Stop the whole process tree?',
        confirmProcTitle: 'Force-stop this process?',
        procsSub: 'processes',
        treeNote: 'Stops each process individually (no process-group escalation), so unrelated commands in the same group are left alone.',
        memberPid: 'PID',
        stopAllTitle: 'Stop every process started by DSH',
        confirmTitle: 'Force-stop this process?',
        confirmKill: 'Stop',
        confirmForce: 'Force kill (SIGKILL)',
        cancel: 'Cancel',
        statTotal: 'background processes',
        statDsh: 'started by DSH',
        statPorts: 'ports in use',
        statMemory: 'MB of memory',
        scanningTip: 'Refreshes every 4 seconds',
        stoppedOk: 'Stopped',
        failed: 'Failed',
        noPort: 'no port',
        session: 'Session',
        lastScan: 'Last scan',
        warn: 'Warning',
        killAllConfirm: 'This stops every process DSH started (DSH itself is untouched). Continue?',
      },
    }

    // ── 语言：跟随 dsh 的 locale 设置，切换时整页跟着换 ───────────────────────
    let currentLang = /^en\b/i.test(navigator.language) ? 'en' : 'zh'
    const langListeners = new Set()

    function setLang(next) {
      const value = next === 'en' ? 'en' : 'zh'
      if (value === currentLang) return
      currentLang = value
      for (const listener of [...langListeners]) listener()
    }

    const label = () => (DICT[currentLang] || DICT.zh).title

    function useLang() {
      const [lang, set] = React.useState(currentLang)
      React.useEffect(() => {
        const listener = () => set(currentLang)
        langListeners.add(listener)
        return () => { langListeners.delete(listener) }
      }, [])
      return lang
    }

    // ── 图标 ──────────────────────────────────────────────────────────────────
    function RadarGlyph(props) {
      const size = (props && props.size) || 18
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
      },
        h('circle', { cx: 12, cy: 12, r: 9 }),
        h('circle', { cx: 12, cy: 12, r: 4.6, opacity: 0.55 }),
        h('path', { d: 'M12 3v18' }),
        h('path', { d: 'M3 12h18' }),
        h('path', { d: 'M12 12 18.4 5.6' }),
        h('circle', { cx: 15.4, cy: 8.6, r: 1.5, fill: 'currentColor', stroke: 'none' }))
    }

    function RefreshIcon() {
      return h('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('path', { d: 'M21 12a9 9 0 1 1-3.2-6.9' }),
        h('path', { d: 'M21 3v6h-6' }))
    }

    function StopIcon() {
      return h('svg', { width: 12, height: 12, viewBox: '0 0 24 24', fill: 'currentColor' },
        h('rect', { x: 6, y: 6, width: 12, height: 12, rx: 2 }))
    }

    function EmptyArt() {
      return h('svg', { width: 108, height: 108, viewBox: '0 0 96 96', fill: 'none', 'aria-hidden': true },
        h('circle', { cx: 48, cy: 48, r: 34, stroke: 'currentColor', strokeOpacity: 0.22, strokeWidth: 1.5 }),
        h('circle', { cx: 48, cy: 48, r: 22, stroke: 'currentColor', strokeOpacity: 0.22, strokeWidth: 1.5 }),
        h('circle', { cx: 48, cy: 48, r: 10, stroke: 'currentColor', strokeOpacity: 0.3, strokeWidth: 1.5 }),
        h('path', { d: 'M48 14v68M14 48h68', stroke: 'currentColor', strokeOpacity: 0.14, strokeWidth: 1.5 }),
        h('path', { d: 'M48 48 74 22', stroke: 'currentColor', strokeOpacity: 0.5, strokeWidth: 2, strokeLinecap: 'round' }))
    }

    // ── 样式：全部走 dsh 主题 token，明暗自动跟随 ──────────────────────────────
    const CSS = `
.ar-root { position: relative; box-sizing: border-box; width: 100%; height: 100%; min-height: 0;
  display: flex; flex-direction: column; overflow: hidden;
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
  font-family: system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; font-size: 13px; }
.ar-root *, .ar-root *::before, .ar-root *::after { box-sizing: border-box; }
.ar-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px;
  padding: 20px 24px 14px; border-bottom: 1px solid var(--dsw-alias-border-l1); flex: 0 0 auto; }
.ar-brand { display: flex; align-items: center; gap: 10px; }
.ar-brand svg { color: var(--dsw-alias-brand-primary); flex: 0 0 auto; }
.ar-title { font-size: 17px; font-weight: 600; letter-spacing: .01em; }
.ar-sub { margin-top: 2px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.ar-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.ar-btn { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary); font-size: 12px; cursor: pointer; white-space: nowrap;
  transition: background .15s ease, border-color .15s ease, opacity .15s ease; }
.ar-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
.ar-btn:disabled { opacity: .5; cursor: default; }
.ar-btn.ar-on { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
.ar-btn.ar-danger { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.ar-btn.ar-danger:hover:not(:disabled) { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); }
.ar-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; display: inline-block; flex: 0 0 auto; }
.ar-body { flex: 1 1 auto; overflow: auto; padding: 16px 24px 28px; }
.ar-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(132px, 1fr)); gap: 10px; margin-bottom: 14px; }
.ar-stat { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; padding: 10px 12px;
  background: var(--dsw-alias-bg-layer-1); }
.ar-stat-v { font-size: 20px; font-weight: 650; line-height: 1.15; font-variant-numeric: tabular-nums; }
.ar-stat-l { margin-top: 2px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.ar-stat-s { margin-top: 1px; font-size: 10.5px; color: var(--dsw-alias-label-secondary); opacity: .75; }
.ar-stat.ar-accent .ar-stat-v { color: var(--dsw-alias-brand-primary); }
.ar-tabs { display: flex; gap: 6px; margin-bottom: 12px; flex-wrap: wrap; align-items: center; }
.ar-tab { height: 26px; padding: 0 11px; border-radius: 999px; font-size: 12px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l1); background: transparent; color: var(--dsw-alias-label-secondary); }
.ar-tab.ar-active { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary);
  border-color: var(--dsw-alias-border-l2); font-weight: 550; }
.ar-spacer { flex: 1 1 auto; }
.ar-meta { font-size: 11px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.ar-table { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; overflow: hidden;
  background: var(--dsw-alias-bg-layer-1); }
.ar-tr { display: grid; grid-template-columns: 92px minmax(180px, 1fr) 84px 104px 74px 96px; gap: 10px;
  align-items: center; padding: 9px 14px; border-top: 1px solid var(--dsw-alias-border-l1); }
.ar-tr:first-child { border-top: 0; }
.ar-th { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-layer-2); padding-top: 8px; padding-bottom: 8px; }
.ar-row:hover { background: var(--dsw-alias-bg-layer-2); }
.ar-ports { display: flex; flex-wrap: wrap; gap: 4px; }
.ar-port { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; padding: 2px 6px;
  border-radius: 6px; background: color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent);
  color: var(--dsw-alias-brand-primary); text-decoration: none; font-variant-numeric: tabular-nums; }
.ar-port:hover { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 24%, transparent); }
.ar-noport { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.ar-proj { font-weight: 550; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ar-proj-line { display: flex; align-items: center; gap: 7px; min-width: 0; }
.ar-chip { font: inherit; font-size: 10.5px; height: 18px; padding: 0 7px; border-radius: 999px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-secondary);
  display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; flex: 0 0 auto; }
.ar-chip:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.ar-chip-open { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-brand-primary); }
.ar-caret { font-size: 9px; line-height: 1; opacity: .85; }
.ar-member { background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 45%, transparent); }
.ar-member .ar-proj { font-weight: 450; font-size: 12px; }
.ar-proj-sub { padding-left: 9px; border-left: 2px solid var(--dsw-alias-border-l2); }
.ar-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
.ar-dialog-note { margin-top: 10px; padding-top: 9px; border-top: 1px dashed var(--dsw-alias-border-l1);
  font-size: 11.5px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.ar-cmd { margin-top: 2px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px;
  color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ar-badge { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; padding: 2px 8px;
  border-radius: 999px; border: 1px solid transparent; white-space: nowrap; }
.ar-badge.ar-b-dsh { color: var(--dsw-alias-brand-primary);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent); }
.ar-badge.ar-b-ext { color: var(--dsw-alias-label-secondary); border-color: var(--dsw-alias-border-l2); }
.ar-num { font-variant-numeric: tabular-nums; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.ar-right { text-align: right; }
.ar-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px;
  padding: 56px 20px; color: var(--dsw-alias-label-secondary); text-align: center; }
.ar-empty svg { color: var(--dsw-alias-brand-primary); opacity: .8; }
.ar-empty-t { font-size: 14px; font-weight: 550; color: var(--dsw-alias-label-primary); }
.ar-empty-h { font-size: 12px; max-width: 380px; line-height: 1.6; }
.ar-warn { margin-top: 12px; padding: 8px 11px; border-radius: 8px; font-size: 12px; line-height: 1.55;
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 40%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent); }
.ar-error { margin-top: 12px; padding: 8px 11px; border-radius: 8px; font-size: 12px;
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); }
.ar-skel { height: 44px; border-radius: 8px; margin-bottom: 8px;
  background: linear-gradient(90deg, var(--dsw-alias-bg-layer-1), var(--dsw-alias-bg-layer-2), var(--dsw-alias-bg-layer-1));
  background-size: 200% 100%; animation: ar-shimmer 1.2s ease-in-out infinite; }
@keyframes ar-shimmer { 0% { background-position: 200% 0 } 100% { background-position: -200% 0 } }
.ar-mask { position: absolute; inset: 0; background: rgba(0,0,0,.34); display: flex; align-items: center;
  justify-content: center; padding: 24px; z-index: 20; }
.ar-dialog { width: min(460px, 100%); border-radius: 14px; border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-overlay); box-shadow: 0 24px 60px rgba(0,0,0,.28); overflow: hidden; }
.ar-dialog-h { padding: 16px 18px 8px; font-size: 14px; font-weight: 600; }
.ar-dialog-b { padding: 0 18px 14px; font-size: 12px; line-height: 1.7; color: var(--dsw-alias-label-secondary); }
.ar-kv { display: grid; grid-template-columns: 68px 1fr; gap: 4px 10px; margin-top: 8px; }
.ar-kv dt { color: var(--dsw-alias-label-secondary); }
.ar-kv dd { margin: 0; color: var(--dsw-alias-label-primary); overflow-wrap: anywhere;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; }
.ar-dialog-f { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 18px 16px;
  border-top: 1px solid var(--dsw-alias-border-l1); }
.ar-toast { position: absolute; left: 50%; bottom: 22px; transform: translateX(-50%); z-index: 30;
  max-width: min(560px, calc(100% - 32px)); display: flex; align-items: center; gap: 10px;
  padding: 9px 14px; border-radius: 999px; font-size: 12px; line-height: 1.5;
  border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-overlay);
  box-shadow: 0 12px 32px rgba(0,0,0,.2); }
.ar-toast.ar-ok { border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 45%, transparent); }
.ar-toast.ar-bad { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent); }
.ar-toast-x { cursor: pointer; color: var(--dsw-alias-label-secondary); flex: 0 0 auto; background: none;
  border: 0; font-size: 14px; line-height: 1; padding: 0 2px; }
@media (max-width: 860px) {
  .ar-tr { grid-template-columns: 76px minmax(120px, 1fr) 72px 84px 88px; }
  .ar-col-mem { display: none; }
}
`

    function useStyles() {
      React.useEffect(() => {
        const el = document.createElement('style')
        el.setAttribute('data-app-radar', '')
        el.textContent = CSS
        document.head.appendChild(el)
        return () => { el.remove() }
      }, [])
    }

    async function callApi(method, params) {
      const response = await fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method, params }),
      })
      const data = await response.json().catch(() => null)
      if (!response.ok) {
        throw new Error((data && data.message) || `HTTP ${response.status}`)
      }
      return data || { ok: false, message: '空响应' }
    }

    function RadarPanel() {
      useStyles()
      const lang = useLang()
      const t = DICT[lang] || DICT.zh
      const [snap, setSnap] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [filter, setFilter] = React.useState('dsh')
      const [auto, setAuto] = React.useState(true)
      const [busy, setBusy] = React.useState(null)
      const [confirm, setConfirm] = React.useState(null)
      const [confirmAll, setConfirmAll] = React.useState(false)
      const [toast, setToast] = React.useState(null)
      const [expanded, setExpanded] = React.useState(() => new Set())
      const alive = React.useRef(true)

      React.useEffect(() => () => { alive.current = false }, [])

      const load = React.useCallback(async (force) => {
        try {
          const data = await callApi('snapshot', force ? { force: true } : undefined)
          if (!alive.current) return
          if (data && data.ok === false) throw new Error(data.message || '扫描失败')
          setSnap(data)
          setError(null)
        } catch (err) {
          if (!alive.current) return
          setError(String((err && err.message) || err))
        }
      }, [])

      React.useEffect(() => { load(true) }, [load])

      React.useEffect(() => {
        if (!auto) return undefined
        const tick = () => { if (!document.hidden) load(false) }
        const id = setInterval(tick, POLL_MS)
        const onVisible = () => { if (!document.hidden) load(false) }
        document.addEventListener('visibilitychange', onVisible)
        return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVisible) }
      }, [auto, load])

      React.useEffect(() => {
        if (!toast) return undefined
        const id = setTimeout(() => setToast(null), 5200)
        return () => clearTimeout(id)
      }, [toast])

      const rows = (snap && snap.rows) || []
      const groups = (snap && snap.groups) || rows.map((r) => ({
        ...r, treeId: r.treeId || r.id, rootPid: r.pid, procCount: 1, memberPids: [r.pid],
      }))
      const summary = (snap && snap.summary) || { total: 0, dsh: 0, groups: 0, dshGroups: 0, ports: 0, rssMB: 0 }
      const visible = filter === 'all' ? groups : groups.filter((g) => g.origin === 'dsh')

      const runStop = async (mode, target, force) => {
        const row = target.row
        const group = target.group
        setBusy(mode === 'tree' ? `tree:${group.treeId}` : `pid:${row ? row.pid : group.rootPid}`)
        try {
          const result = mode === 'tree'
            ? await callApi('killTree', { treeId: group.treeId, force: Boolean(force) })
            : await callApi('kill', { pid: row ? row.pid : group.rootPid, force: Boolean(force) })
          if (result.ok) {
            setToast({ kind: 'ok', text: result.message || t.stoppedOk })
            setConfirm(null)
          } else if (result.needsForce) {
            setToast({ kind: 'bad', text: result.message, forceTarget: { mode, target } })
            setConfirm(null)
          } else {
            setToast({ kind: 'bad', text: result.message || t.failed })
          }
          await load(true)
        } catch (err) {
          setToast({ kind: 'bad', text: String((err && err.message) || err) })
        } finally {
          if (alive.current) setBusy(null)
        }
      }

      const stopAll = async () => {
        setBusy('all')
        try {
          const result = await callApi('stopAll')
          setToast({ kind: result.ok ? 'ok' : 'bad', text: result.message })
          await load(true)
        } catch (err) {
          setToast({ kind: 'bad', text: String((err && err.message) || err) })
        } finally {
          if (alive.current) setBusy(null)
          if (alive.current) setConfirmAll(false)
        }
      }

      const stat = (value, label, accent, sub) => h('div', { className: `ar-stat${accent ? ' ar-accent' : ''}` },
        h('div', { className: 'ar-stat-v' }, value),
        h('div', { className: 'ar-stat-l' }, label),
        sub ? h('div', { className: 'ar-stat-s' }, sub) : null)

      const portCell = (ports) => ports && ports.length
        ? h('div', { className: 'ar-ports' }, ports.map((port) => h('a', {
          key: port,
          className: 'ar-port',
          href: `http://127.0.0.1:${port}`,
          target: '_blank',
          rel: 'noreferrer',
          title: `打开 http://127.0.0.1:${port}`,
        }, `:${port}`)))
        : h('span', { className: 'ar-noport' }, t.noPort)

      const headRow = h('div', { className: 'ar-tr ar-th' },
        h('div', null, t.colPort),
        h('div', null, t.colProject),
        h('div', null, t.colOrigin),
        h('div', null, t.colUptime),
        h('div', { className: 'ar-col-mem' }, t.colMemory),
        h('div', { className: 'ar-right' }, t.colAction))

      const toggleExpand = (treeId) => {
        setExpanded((prev) => {
          const next = new Set(prev)
          if (next.has(treeId)) next.delete(treeId)
          else next.add(treeId)
          return next
        })
      }

      const groupNode = (g) => {
        const isMulti = (g.procCount || 1) > 1
        const open = expanded.has(g.treeId)
        return h('div', { key: g.id, className: 'ar-tr ar-row' },
          h('div', null, portCell(g.ports)),
          h('div', { style: { minWidth: 0 } },
            h('div', { className: 'ar-proj-line' },
              h('div', { className: 'ar-proj', title: g.command || '' }, g.label || `pid ${g.rootPid}`),
              isMulti ? h('button', {
                className: `ar-chip${open ? ' ar-chip-open' : ''}`,
                onClick: () => toggleExpand(g.treeId),
                title: open ? t.collapseHint : t.expandHint,
              },
                h('span', null, `${g.procCount} ${t.procsSub}`),
                h('span', { className: 'ar-caret' }, open ? '▾' : '▸')) : null),
            h('div', { className: 'ar-cmd', title: g.command || '' }, g.command || '')),
          h('div', null,
            h('span', { className: `ar-badge ${g.origin === 'dsh' ? 'ar-b-dsh' : 'ar-b-ext'}` },
              g.origin === 'dsh' ? t.dshOrigin : t.externalOrigin)),
          h('div', { className: 'ar-num' }, g.etimeText || '—'),
          h('div', { className: 'ar-num ar-col-mem' }, snap && snap.degraded ? '—' : `${g.rssMB || 0} MB`),
          h('div', { className: 'ar-right' },
            h('button', {
              className: 'ar-btn ar-danger',
              disabled: !g.killable || busy !== null,
              title: g.killable ? undefined : g.guard,
              onClick: () => setConfirm(isMulti ? { mode: 'tree', group: g } : { mode: 'proc', group: g }),
            },
              h(StopIcon, null),
              isMulti ? t.stopTree : t.stop)))
      }

      const memberNodes = (g) => {
        if (!expanded.has(g.treeId)) return []
        return rows.filter((r) => r.treeId === g.treeId).map((r) => h('div', { key: r.id, className: 'ar-tr ar-row ar-member' },
          h('div', null, portCell(r.ports)),
          h('div', { style: { minWidth: 0 } },
            h('div', { className: 'ar-proj ar-proj-sub', title: r.cwd || r.command || '' },
              r.project || r.label || `pid ${r.pid}`),
            h('div', { className: 'ar-cmd', title: r.command || '' }, r.command || '')),
          h('div', { className: 'ar-num ar-mono' }, `pid ${r.pid}`),
          h('div', { className: 'ar-num' }, r.etimeText || '—'),
          h('div', { className: 'ar-num ar-col-mem' }, snap && snap.degraded ? '—' : `${r.rssMB || 0} MB`),
          h('div', { className: 'ar-right' },
            h('button', {
              className: 'ar-btn ar-danger',
              disabled: !r.killable || busy !== null,
              title: r.killable ? undefined : r.guard,
              onClick: () => setConfirm({ mode: 'proc', group: g, row: r }),
            }, h(StopIcon, null), t.stop))))
      }

      const body = () => {
        if (!snap) {
          return h('div', null,
            h('div', { className: 'ar-skel', style: { width: '100%' } }),
            h('div', { className: 'ar-skel', style: { width: '92%' } }),
            h('div', { className: 'ar-skel', style: { width: '96%' } }))
        }
        if (!visible.length) {
          const allEmpty = filter === 'all'
          return h('div', { className: 'ar-empty' },
            h(EmptyArt, null),
            h('div', { className: 'ar-empty-t' }, allEmpty ? t.emptyAll : t.empty),
            h('div', { className: 'ar-empty-h' }, allEmpty ? t.emptyAllHint : t.emptyHint))
        }
        return h('div', { className: 'ar-table' },
          headRow,
          visible.flatMap((g) => [groupNode(g), ...memberNodes(g)]))
      }

      const busyAll = busy === 'all'

      return h('div', { className: 'ar-root' },
        h('div', { className: 'ar-head' },
          h('div', { className: 'ar-brand' },
            h(RadarGlyph, { size: 22 }),
            h('div', null,
              h('div', { className: 'ar-title' }, t.title),
              h('div', { className: 'ar-sub' }, t.subtitle))),
          h('div', { className: 'ar-actions' },
            h('button', {
              className: `ar-btn${auto ? ' ar-on' : ''}`,
              onClick: () => setAuto((v) => !v),
              title: t.scanningTip,
            }, h('span', { className: 'ar-dot' }), t.auto),
            h('button', { className: 'ar-btn', onClick: () => load(true), disabled: busy !== null },
              h(RefreshIcon, null), t.refresh),
            h('button', {
              className: 'ar-btn ar-danger',
              disabled: busy !== null || !(summary.dshGroups ?? summary.dsh),
              onClick: () => setConfirmAll(true),
              title: t.stopAllTitle,
            }, h(StopIcon, null), t.stopAll))),

        h('div', { className: 'ar-body' },
          h('div', { className: 'ar-stats' },
            stat(summary.total, t.statTotal),
            stat(summary.dshGroups ?? summary.dsh, t.statDsh, true, `${summary.dsh} ${t.procsSub}`),
            stat(summary.ports, t.statPorts),
            stat(snap && snap.degraded ? '—' : Math.round(visible.reduce((n, g) => n + (g.rssMB || 0), 0)), t.statMemory)),

          h('div', { className: 'ar-tabs' },
            h('button', { className: `ar-tab${filter === 'dsh' ? ' ar-active' : ''}`, onClick: () => setFilter('dsh') }, `${t.filterDsh} ${summary.dshGroups ?? summary.dsh}`),
            h('button', { className: `ar-tab${filter === 'all' ? ' ar-active' : ''}`, onClick: () => setFilter('all') }, `${t.filterAll} ${summary.groups ?? summary.total}`),
            h('div', { className: 'ar-spacer' }),
            snap ? h('div', { className: 'ar-meta' }, `${t.lastScan} ${new Date(snap.generatedAt).toLocaleTimeString()} · ${snap.scanMs}ms`) : null),

          body(),

          error ? h('div', { className: 'ar-error' }, `${t.failed}：${error}`) : null,
          snap && snap.warnings && snap.warnings.length
            ? h('div', { className: 'ar-warn' }, `${t.warn}：${snap.warnings.join('；')}`)
            : null),

        confirm ? h('div', { className: 'ar-mask', onClick: (e) => { if (e.target === e.currentTarget) setConfirm(null) } },
          h('div', { className: 'ar-dialog' },
            h('div', { className: 'ar-dialog-h' }, confirm.mode === 'tree' ? t.confirmTreeTitle : t.confirmProcTitle),
            h('div', { className: 'ar-dialog-b' },
              h('dl', { className: 'ar-kv' },
                h('dt', null, t.colPort),
                h('dd', null, (() => {
                  const ports = confirm.row ? confirm.row.ports : confirm.group.ports
                  return ports && ports.length ? ports.map((p) => `:${p}`).join(' ') : t.noPort
                })()),
                h('dt', null, t.colProject),
                h('dd', null, (confirm.row ? (confirm.row.project || confirm.row.label) : confirm.group.label) || '—'),
                h('dt', null, 'PID'),
                h('dd', null, confirm.mode === 'tree'
                  ? `${confirm.group.rootPid}（${confirm.group.procCount} ${t.procsSub}）`
                  : `${confirm.row ? confirm.row.pid : confirm.group.rootPid}${(confirm.row ? confirm.row.groupKill : false) ? ` / PGID ${confirm.row.pgid}` : ''}`),
                h('dt', null, t.colUptime),
                h('dd', null, (confirm.row ? confirm.row.etimeText : confirm.group.etimeText) || '—'),
                h('dt', null, 'CWD'),
                h('dd', null, (confirm.row ? confirm.row.cwd : confirm.group.cwd) || '—'),
                (confirm.row ? confirm.row.command : confirm.group.command) ? h('dt', null, 'CMD') : null,
                (confirm.row ? confirm.row.command : confirm.group.command)
                  ? h('dd', null, confirm.row ? confirm.row.command : confirm.group.command) : null),
              confirm.mode === 'tree' ? h('div', { className: 'ar-dialog-note' }, t.treeNote) : null),
            h('div', { className: 'ar-dialog-f' },
              h('button', { className: 'ar-btn', onClick: () => setConfirm(null) }, t.cancel),
              h('button', {
                className: 'ar-btn ar-danger',
                disabled: busy !== null,
                onClick: () => runStop(confirm.mode, { group: confirm.group, row: confirm.row }, false),
              }, h(StopIcon, null), t.confirmKill),
              h('button', {
                className: 'ar-btn ar-danger',
                disabled: busy !== null,
                onClick: () => runStop(confirm.mode, { group: confirm.group, row: confirm.row }, true),
              }, h(StopIcon, null), t.confirmForce)))) : null,

        confirmAll ? h('div', { className: 'ar-mask', onClick: (e) => { if (e.target === e.currentTarget) setConfirmAll(false) } },
          h('div', { className: 'ar-dialog' },
            h('div', { className: 'ar-dialog-h' }, t.stopAllTitle),
            h('div', { className: 'ar-dialog-b' }, t.killAllConfirm),
            h('div', { className: 'ar-dialog-f' },
              h('button', { className: 'ar-btn', onClick: () => setConfirmAll(false) }, t.cancel),
              h('button', { className: 'ar-btn ar-danger', disabled: busyAll, onClick: stopAll },
                h(StopIcon, null), busyAll ? t.scanning : t.stopAll)))) : null,

        toast ? h('div', { className: `ar-toast ${toast.kind === 'ok' ? 'ar-ok' : 'ar-bad'}` },
          h('span', null, toast.text),
          toast.forceTarget ? h('button', {
            className: 'ar-btn ar-danger',
            disabled: busy !== null,
            onClick: () => runStop(toast.forceTarget.mode, toast.forceTarget.target, true),
          }, t.confirmForce) : null,
          h('button', { className: 'ar-toast-x', onClick: () => setToast(null), 'aria-label': t.cancel }, '×')) : null)
    }

    function apply(ctx) {
      // 界面文案跟随 dsh 的语言设置
      ctx.inject(['locale'], (c) => {
        try {
          const snap = c.locale.getSnapshot()
          const active = snap && snap.active
          if (typeof active === 'string' && /^en\b/i.test(active)) setLang('en')
          else if (typeof active === 'string') setLang('zh')
          c.on('locale/change', (next) => {
            const id = next && next.active
            setLang(typeof id === 'string' && /^en\b/i.test(id) ? 'en' : 'zh')
          })
        } catch { /* 老版本没有 locale 服务时跟随浏览器语言 */ }
      })

      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
        { name: 'sidebar.panellist', id: PANEL, order: 7, label: () => label() },
        function RadarEntryIcon(props) { return h(RadarGlyph, { size: (props && props.size) || 18 }) }))
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL }, RadarPanel))
    }

    exports.isPlugin = true
    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})

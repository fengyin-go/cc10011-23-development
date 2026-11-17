import { useCallback, useState } from 'react'

import {
  closeReadSession,
  executeLanding,
  landingStats,
  listBatches,
  listConflicts,
  listFiles,
  listManifest,
  listSessions,
  openReadSession,
  planLanding,
  recoverLanding,
  resolveConflict,
  resetLandingState,
} from '@/api/landing-service'
import { listRows } from '@/data/local-store'
import type { ConflictDecision, InjectOptions, SwitchMode } from '@/data/landing-types'

const TABS = ['落盘执行', '分区清单', '分区文件', '读取会话', '切换冲突'] as const
type TabKey = (typeof TABS)[number]

const SWITCH_MODES: SwitchMode[] = ['完成后立即切换分区指向', '等旧版本读取会话结束后再切换']

const STATE_BADGE: Record<string, string> = {
  预留: 'badge reserve',
  写入: 'badge writing',
  切换: 'badge switched',
  归档: 'badge archived',
  失败: 'badge failed',
}

const BATCH_BADGE: Record<string, string> = {
  写入中: 'badge writing',
  已中断: 'badge failed',
  待切换: 'badge reserve',
  已切换: 'badge switched',
  已失败: 'badge failed',
  已复核: 'badge reviewed',
}

function newRequestId(): string {
  return `req-${Date.now().toString(36)}-${Math.floor(Math.random() * 900 + 100)}`
}

export default function LandingConsole() {
  const [tab, setTab] = useState<TabKey>('落盘执行')
  const [signal, setSignal] = useState(0)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const refresh = useCallback(() => setSignal((value) => value + 1), [])

  const stats = landingStats()
  const configs = listRows('storage')

  const notify = (ok: boolean, text: string) => {
    setMessage({ ok, text })
    refresh()
  }

  return (
    <section className="landing-console" data-signal={signal}>
      <header className="console-head">
        <div>
          <h3>原子落盘工作台</h3>
          <p className="page-desc">
            分区预留、文件写入与可见版本切换在同一事务提交；下游只读取数据落盘分区清单里的完整版本，失败临时文件不会顶替上一版。
          </p>
        </div>
        <button
          className="btn ghost"
          type="button"
          onClick={() => notify(resetLandingState().ok, resetLandingState().message)}
        >
          重置落盘演示数据
        </button>
      </header>

      <div className="stat-row">
        <article className="stat-card">
          <span className="stat-label">落盘批次</span>
          <strong className="stat-value">{stats.batchCount}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">清单当前分区</span>
          <strong className="stat-value">{stats.visiblePartitionCount}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">待切换分区</span>
          <strong className="stat-value">{stats.pendingSwitchCount}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">活跃读取会话</span>
          <strong className="stat-value">{stats.activeSessionCount}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">失败临时文件</span>
          <strong className="stat-value">{stats.failedFileCount}</strong>
        </article>
      </div>

      <nav className="tab-bar">
        {TABS.map((item) => (
          <button
            key={item}
            type="button"
            className={`tab-item ${tab === item ? 'active' : ''}`}
            onClick={() => setTab(item)}
          >
            {item}
          </button>
        ))}
      </nav>

      {message && (
        <p className={`console-message ${message.ok ? 'ok' : 'fail'}`}>
          {message.text}
          <button type="button" className="link" onClick={() => setMessage(null)}>关闭</button>
        </p>
      )}

      {tab === '落盘执行' && <ExecutePanel configs={configs} notify={notify} />}
      {tab === '分区清单' && <ManifestPanel />}
      {tab === '分区文件' && <FilesPanel />}
      {tab === '读取会话' && <SessionsPanel notify={notify} />}
      {tab === '切换冲突' && <ConflictsPanel notify={notify} />}
    </section>
  )
}

type Notify = (ok: boolean, text: string) => void

function ExecutePanel({
  configs,
  notify,
}: {
  configs: ReturnType<typeof listRows>
  notify: Notify
}) {
  const [configId, setConfigId] = useState<number>(configs[0] ? Number(configs[0].id) : 0)
  const [switchMode, setSwitchMode] = useState<SwitchMode>('完成后立即切换分区指向')
  const [requestId, setRequestId] = useState(newRequestId())
  const [inject, setInject] = useState<'none' | 'fail' | 'interrupt'>('none')
  const batches = listBatches()

  const selected = configs.find((row) => Number(row.id) === configId)
  const preview = selected ? planLanding(configId) : undefined

  function run() {
    const options: InjectOptions = {}
    if (inject === 'fail') {
      options.failPartition = preview?.plan?.partitions[1] ?? ''
    }
    if (inject === 'interrupt') {
      options.interruptAfter = 1
    }
    const result = executeLanding({ configId, requestId, switchMode, inject: options })
    notify(result.ok, result.message)
    setRequestId(newRequestId())
  }

  return (
    <div className="panel-stack">
      <form
        className="landing-form"
        onSubmit={(event) => {
          event.preventDefault()
          run()
        }}
      >
        <label className="form-item">
          <span>存储配置（读取输出路径/分区策略/文件格式/覆写模式）</span>
          <select value={configId} onChange={(event) => setConfigId(Number(event.target.value))}>
            {configs.map((row) => (
              <option key={String(row.id)} value={Number(row.id)}>
                {String(row['配置编号'])} ｜ {String(row['输出路径'])} ｜ {String(row['分区策略'])} ｜ {String(row['覆写模式'])}
              </option>
            ))}
          </select>
        </label>
        <label className="form-item">
          <span>可见版本切换方式</span>
          <select value={switchMode} onChange={(event) => setSwitchMode(event.target.value as SwitchMode)}>
            {SWITCH_MODES.map((mode) => (
              <option key={mode} value={mode}>{mode}</option>
            ))}
          </select>
        </label>
        <label className="form-item">
          <span>幂等请求号（重复提交不会生成两个当前清单项）</span>
          <input value={requestId} onChange={(event) => setRequestId(event.target.value)} />
        </label>
        <label className="form-item">
          <span>故障注入（验证半文件防护与中断恢复）</span>
          <select value={inject} onChange={(event) => setInject(event.target.value as typeof inject)}>
            <option value="none">无故障，正常完整落盘</option>
            <option value="fail">第二个分区写入失败</option>
            <option value="interrupt">完成 1 个分区后进程中断</option>
          </select>
        </label>
        <div className="form-actions">
          <button className="btn primary" type="submit">执行原子落盘</button>
        </div>
      </form>

      {preview?.plan && (
        <article className="plan-card">
          <strong>本次落盘计划</strong>
          <p>
            输出路径 {preview.plan.outputPath} ｜ 文件格式 {preview.plan.fileFormat} ｜
            覆写模式 {preview.plan.overwriteMode} ｜ 版本 {preview.plan.version}
          </p>
          <p>待写入分区（{preview.plan.partitions.length}）：{preview.plan.partitions.join('，')}</p>
        </article>
      )}

      <table className="data-table">
        <thead>
          <tr>
            <th>批次</th><th>配置编号</th><th>版本</th><th>状态</th><th>尝试</th>
            <th>检查点</th><th>已切换/待切换/追加</th><th>校验</th><th>复核</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          {batches.map((batch) => (
            <tr key={batch.batchId}>
              <td>{batch.batchId}</td>
              <td>{batch.configNo}</td>
              <td>{batch.version}</td>
              <td><span className={BATCH_BADGE[batch.state] ?? 'badge'}>{batch.state}</span></td>
              <td>{batch.attempt}</td>
              <td>{batch.checkpointPartition ?? '—'}</td>
              <td>
                {batch.switchedPartitions.length}/{batch.pendingPartitions.length}/{batch.appendedPartitions.length}
                {batch.failPartition && <em className="error-text">（失败：{batch.failPartition}）</em>}
              </td>
              <td>{batch.verified ?? '—'}</td>
              <td>{batch.reviewed ? '已复核' : '—'}</td>
              <td className="row-actions">
                {(batch.state === '已中断' || (batch.state === '已失败' && !batch.rejected)) && (
                  <button
                    type="button"
                    className="link"
                    onClick={() => {
                      const result = recoverLanding(batch.batchId)
                      notify(result.ok, result.message)
                    }}
                  >
                    从检查点恢复
                  </button>
                )}
                {batch.state === '已失败' && batch.rejected && (
                  <span className="muted-text">策略拒绝，需调整后重提</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ManifestPanel() {
  const manifest = listManifest()
  return (
    <div className="panel-stack">
      <p className="page-desc">
        数据落盘分区清单：每个分区至多一条当前项，下游作业只读这里登记的完整文件；切换在单事务内完成，读不到半个文件。
      </p>
      <table className="data-table">
        <thead>
          <tr>
            <th>分区</th><th>配置编号</th><th>当前文件</th><th>当前版本</th>
            <th>可见路径</th><th>来源批次</th><th>切换时间</th><th>上一版（已归档）</th>
          </tr>
        </thead>
        <tbody>
          {manifest.map((entry) => (
            <tr key={entry.partition}>
              <td>{entry.partition}</td>
              <td>{entry.configNo}</td>
              <td>{entry.currentFileId}</td>
              <td><strong>{entry.version}</strong></td>
              <td className="path-cell">{entry.finalPath}</td>
              <td>{entry.batchId}</td>
              <td>{entry.switchedAt.replace('T', ' ').slice(0, 19)}</td>
              <td>{entry.previousFileId ?? '—'}</td>
            </tr>
          ))}
          {manifest.length === 0 && (
            <tr><td className="empty-state" colSpan={8}>清单为空，尚无完整可见版本</td></tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

function FilesPanel() {
  const files = listFiles()
  return (
    <div className="panel-stack">
      <p className="page-desc">
        分区文件状态流转：预留 → 写入 → 切换 → 归档；写入失败停在「失败」，临时文件保留在 .tmp 但永远不进入清单。
      </p>
      <table className="data-table">
        <thead>
          <tr>
            <th>文件</th><th>分区</th><th>状态</th><th>检查点</th>
            <th>临时路径（下游不可见）</th><th>完整路径</th><th>校验和</th><th>说明</th>
          </tr>
        </thead>
        <tbody>
          {files.map((file) => (
            <tr key={file.fileId}>
              <td>{file.fileId}</td>
              <td>{file.partition}</td>
              <td><span className={STATE_BADGE[file.state] ?? 'badge'}>{file.state}</span></td>
              <td>{file.checkpoint ? '已记录' : '—'}</td>
              <td className="path-cell temp-path">{file.tempPath}</td>
              <td className="path-cell">{file.finalPath}</td>
              <td>{file.checksum || '—'}</td>
              <td>{file.failureMessage ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function SessionsPanel({ notify }: { notify: Notify }) {
  const manifest = listManifest()
  const sessions = listSessions()
  const [partition, setPartition] = useState(manifest[0]?.partition ?? '')
  const [jobName, setJobName] = useState('nightly-aggregation')

  return (
    <div className="panel-stack">
      <form
        className="landing-form"
        onSubmit={(event) => {
          event.preventDefault()
          const result = openReadSession(partition, jobName)
          notify(result.ok, result.message)
        }}
      >
        <label className="form-item">
          <span>读取分区（来自数据落盘分区清单）</span>
          <select value={partition} onChange={(event) => setPartition(event.target.value)}>
            {manifest.map((entry) => (
              <option key={entry.partition} value={entry.partition}>
                {entry.partition}（当前 {entry.version}）
              </option>
            ))}
          </select>
        </label>
        <label className="form-item">
          <span>作业名称</span>
          <input value={jobName} onChange={(event) => setJobName(event.target.value)} />
        </label>
        <div className="form-actions">
          <button className="btn primary" type="submit">打开读取会话</button>
        </div>
      </form>

      <table className="data-table">
        <thead>
          <tr>
            <th>会话</th><th>分区</th><th>锁定版本</th><th>作业</th><th>状态</th>
            <th>开始时间</th><th>结束时间</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((session) => (
            <tr key={session.sessionId}>
              <td>{session.sessionId}</td>
              <td>{session.partition}</td>
              <td>{session.version}</td>
              <td>{session.jobName}</td>
              <td>{session.active ? <span className="badge writing">读取中</span> : <span className="badge archived">已结束</span>}</td>
              <td>{session.startedAt.replace('T', ' ').slice(0, 19)}</td>
              <td>{session.endedAt ? session.endedAt.replace('T', ' ').slice(0, 19) : '—'}</td>
              <td className="row-actions">
                {session.active && (
                  <button
                    type="button"
                    className="link"
                    onClick={() => {
                      const result = closeReadSession(session.sessionId)
                      notify(result.ok, result.message)
                    }}
                  >
                    结束会话并切换待切版本
                  </button>
                )}
              </td>
            </tr>
          ))}
          {sessions.length === 0 && (
            <tr><td className="empty-state" colSpan={8}>暂无读取会话</td></tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

function ConflictsPanel({ notify }: { notify: Notify }) {
  const conflicts = listConflicts()
  const decisions: ConflictDecision[] = ['立即切换路径', '会话结束后切换']
  return (
    <div className="panel-stack">
      <p className="page-desc">
        新文件即将完成而旧文件仍被作业读取时登记冲突：比较「完成后立即切换分区指向」与「等旧版本读取会话结束后再切换」
        两种处置的文件可见时间，判定结果写入冲突单，数据落盘分区清单供复核。
      </p>
      <table className="data-table">
        <thead>
          <tr>
            <th>冲突</th><th>批次</th><th>分区</th><th>新文件</th><th>读取会话</th>
            <th>当前处置</th><th>结果校验</th><th>说明</th><th>仲裁</th>
          </tr>
        </thead>
        <tbody>
          {conflicts.map((conflict) => (
            <tr key={conflict.conflictId}>
              <td>{conflict.conflictId}</td>
              <td>{conflict.batchId}</td>
              <td>{conflict.partition}</td>
              <td>{conflict.newFileId}</td>
              <td>{conflict.activeSessionId}</td>
              <td><span className={conflict.status === '立即切换' ? 'badge switched' : 'badge reserve'}>{conflict.status}</span></td>
              <td>{conflict.verifyStatus ?? '—'}</td>
              <td>{conflict.note ?? '—'}</td>
              <td className="row-actions">
                {!conflict.resolvedAt && decisions.map((decision) => (
                  <button
                    key={decision}
                    type="button"
                    className="link"
                    onClick={() => {
                      const result = resolveConflict(conflict.conflictId, decision)
                      notify(result.ok, result.message)
                    }}
                  >
                    {decision}
                  </button>
                ))}
                {conflict.resolvedAt && <span className="muted-text">{conflict.decision}</span>}
              </td>
            </tr>
          ))}
          {conflicts.length === 0 && (
            <tr><td className="empty-state" colSpan={9}>暂无切换冲突</td></tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

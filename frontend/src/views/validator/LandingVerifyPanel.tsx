import { useState } from 'react'

import {
  landingStats,
  listBatches,
  listFiles,
  listManifest,
  reviewBatch,
  verifyBatch,
} from '@/api/landing-service'

/**
 * 结果校验侧的待处理区：同步读取数据落盘分区清单，
 * 确认目标批次已完整可见后才允许通过；未完成分区不会进入校验范围。
 */
export default function LandingVerifyPanel() {
  const [signal, setSignal] = useState(0)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const refresh = () => setSignal((value) => value + 1)

  // signal 参与读取，保证落盘页切换分区指向后这里能拿到最新清单。
  void signal
  const batches = listBatches()
  const manifest = listManifest()
  const allFiles = listFiles()
  const stats = landingStats()

  const notify = (ok: boolean, text: string) => {
    setMessage({ ok, text })
    refresh()
  }

  return (
    <section className="landing-console verify-console">
      <header className="console-head">
        <div>
          <h3>数据落盘分区清单核对（待处理区）</h3>
          <p className="page-desc">
            同步读取数据落盘分区清单：目标批次的每个分区都完整可见才进入校验，待切换/失败分区不在校验范围内；
            复核依据为「完成后立即切换分区指向」。
          </p>
        </div>
      </header>

      <div className="stat-row">
        <article className="stat-card">
          <span className="stat-label">清单当前分区</span>
          <strong className="stat-value">{stats.visiblePartitionCount}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">待切换分区</span>
          <strong className="stat-value">{stats.pendingSwitchCount}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">待复核批次</span>
          <strong className="stat-value">
            {batches.filter((batch) => batch.verified === '通过' && !batch.reviewed).length}
          </strong>
        </article>
      </div>

      {message && (
        <p className={`console-message ${message.ok ? 'ok' : 'fail'}`}>
          {message.text}
          <button type="button" className="link" onClick={() => setMessage(null)}>关闭</button>
        </p>
      )}

      <table className="data-table">
        <thead>
          <tr>
            <th>批次</th><th>配置编号</th><th>版本</th><th>批次状态</th>
            <th>清单核对（完整可见分区数）</th><th>校验状态</th><th>复核</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          {batches.map((batch) => {
            const fileCompleteCount = batch.partitions.filter((partition) => {
              const manifestHas = manifest.some((entry) => entry.partition === partition)
              if (batch.appendedPartitions.includes(partition)) {
                return manifestHas
              }
              const file = [...allFiles].find(
                (item) => item.batchId === batch.batchId && item.partition === partition,
              )
              return manifestHas && !!file && file.checkpoint && file.state !== '失败' && file.state !== '预留'
            }).length
            const fullyVisible =
              fileCompleteCount === batch.partitions.length && batch.pendingPartitions.length === 0
            return (
              <tr key={batch.batchId}>
                <td>{batch.batchId}</td>
                <td>{batch.configNo}</td>
                <td>{batch.version}</td>
                <td>{batch.state}</td>
                <td>
                  {fileCompleteCount}/{batch.partitions.length}
                  {fullyVisible ? (
                    <span className="badge switched"> 完整可见</span>
                  ) : (
                    <span className="badge reserve"> 未完成不进校</span>
                  )}
                </td>
                <td>
                  {batch.verified ?? '—'}
                  {batch.verifyMessage && <em className="muted-text">（{batch.verifyMessage.slice(0, 18)}…）</em>}
                </td>
                <td>{batch.reviewed ? '已复核' : '—'}</td>
                <td className="row-actions">
                  <button
                    type="button"
                    className="link"
                    onClick={() => {
                      const result = verifyBatch(batch.batchId, true)
                      notify(result.ok, result.message)
                    }}
                  >
                    校验通过
                  </button>
                  <button
                    type="button"
                    className="link"
                    onClick={() => {
                      const result = verifyBatch(batch.batchId, false)
                      notify(result.ok, result.message)
                    }}
                  >
                    校验驳回
                  </button>
                  <button
                    type="button"
                    className="link"
                    onClick={() => {
                      const result = reviewBatch(batch.batchId)
                      notify(result.ok, result.message)
                    }}
                  >
                    复核确认
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </section>
  )
}

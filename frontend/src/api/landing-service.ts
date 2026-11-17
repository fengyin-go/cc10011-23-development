import { listRows } from '@/data/local-store'
import { commit, landingState, nextId, resetLanding } from '@/data/landing-store'
import type {
  ConflictDecision,
  InjectOptions,
  LandingBatch,
  LandingResult,
  LandingStats,
  OverwriteMode,
  PartitionCurrent,
  PartitionFile,
  ReadSession,
  SwitchConflict,
  SwitchMode,
} from '@/data/landing-types'

/**
 * 原子落盘服务：把「分区预留、文件写入、可见版本切换」放进同一次持久化事务，
 * 并维护数据落盘分区清单（manifest）。所有函数同步执行，模拟真实落盘引擎的
 * 串行化语义——同一分区同一时刻只有一个写者，清单里每个分区至多一个当前项。
 */

const EXTENSIONS: Record<string, string> = {
  parquet: 'parquet',
  orc: 'orc',
  json: 'json',
  csv: 'csv',
  text: 'txt',
  avro: 'avro',
}

const OVERWRITE_ALIASES: Record<string, OverwriteMode> = {
  原子覆写: '原子覆写',
  拒绝覆写: '拒绝覆写',
  追加写: '追加写',
  覆写: '原子覆写',
  拒绝: '拒绝覆写',
  追加: '追加写',
}

function nowIso(): string {
  return new Date().toISOString()
}

function todayStamp(): string {
  return nowIso().slice(0, 10)
}

function normalizeOverwrite(raw: string | undefined): OverwriteMode {
  if (!raw) {
    return '原子覆写'
  }
  const hit = OVERWRITE_ALIASES[raw.trim()]
  return hit ?? '原子覆写'
}

function extensionOf(fileFormat: string): string {
  return EXTENSIONS[fileFormat.trim().toLowerCase()] ?? 'dat'
}

/** 按分区策略把一次落盘拆成待写入分区；未识别的策略回退到单分区根目录。 */
export function resolvePartitions(strategy: string, day: string): string[] {
  const text = strategy.trim()
  if (text.includes('日') || text.toLowerCase().includes('date')) {
    return ['east', 'south', 'north'].map((region) => `dt=${day}/region=${region}`)
  }
  if (text.includes('小时') || text.toLowerCase().includes('hour')) {
    return ['00', '12'].map((hour) => `dt=${day}/hour=${hour}`)
  }
  if (text.includes('区域') || text.includes('地区') || text.toLowerCase().includes('region')) {
    return ['region=east', 'region=south']
  }
  if (text.includes('不分') || text.includes('单分区') || text === '') {
    return ['__root__']
  }
  return [`seg=${text}`]
}

function getConfig(configId: number) {
  const row = listRows('storage').find((item) => Number(item.id) === Number(configId))
  if (!row) {
    return undefined
  }
  return {
    id: Number(row.id),
    configNo: String(row['配置编号'] ?? `STOR-${configId}`),
    storageType: String(row['存储类型'] ?? ''),
    outputPath: String(row['输出路径'] ?? '/data/landing'),
    fileFormat: String(row['文件格式'] ?? 'JSON'),
    partitionStrategy: String(row['分区策略'] ?? '单分区'),
    overwriteMode: normalizeOverwrite(String(row['覆写模式'] ?? '原子覆写')),
  }
}

export type LandingPlan = {
  configId: number
  configNo: string
  outputPath: string
  partitionStrategy: string
  fileFormat: string
  overwriteMode: OverwriteMode
  partitions: string[]
  version: string
}

/** 读取输出路径、分区策略、文件格式和覆写模式，产出本次落盘计划（不写任何数据）。 */
export function planLanding(configId: number, requestId?: string): LandingResult & { plan?: LandingPlan } {
  const config = getConfig(configId)
  if (!config) {
    return { ok: false, message: `没有找到编号为 ${configId} 的存储配置` }
  }
  const day = todayStamp()
  const plan: LandingPlan = {
    configId: config.id,
    configNo: config.configNo,
    outputPath: config.outputPath,
    partitionStrategy: config.partitionStrategy,
    fileFormat: config.fileFormat,
    overwriteMode: config.overwriteMode,
    partitions: resolvePartitions(config.partitionStrategy, day),
    version: `v${day.replace(/-/g, '')}-${String(Date.now()).slice(-6)}-r1`,
  }
  if (requestId) {
    const duplicate = landingState().batches.find((batch) => batch.requestId === requestId)
    if (duplicate) {
      return {
        ok: false,
        message: `请求 ${requestId} 已提交过，复用批次 ${duplicate.batchId}，不会生成第二个当前清单项`,
        batch: duplicate,
      }
    }
  }
  return { ok: true, message: '落盘计划已生成', plan }
}

function tempPathOf(outputPath: string, batchId: string, partition: string, ext: string): string {
  const dir = partition === '__root__' ? '' : `/${partition}`
  return `${outputPath}/.tmp/${batchId}${dir}/part.tmp.${ext}`
}

function finalPathOf(outputPath: string, partition: string, ext: string): string {
  const dir = partition === '__root__' ? '' : `/${partition}`
  return `${outputPath}${dir}/part.${ext}`
}

function activeSessionFor(state: ReturnType<typeof landingState>, partition: string): ReadSession | undefined {
  return state.sessions.find((session) => session.active && session.partition === partition)
}

function currentOf(state: ReturnType<typeof landingState>, partition: string): PartitionCurrent | undefined {
  return state.manifest.find((item) => item.partition === partition)
}

type ExecuteInput = {
  configId: number
  requestId: string
  switchMode: SwitchMode
  inject?: InjectOptions
}

/**
 * 执行原子落盘。整个批次的每一次分区推进（预留→写入→切换）都在 commit 事务里完成，
 * 写入失败的分区停在「失败」，上一版清单原样保留，临时文件永远不进 manifest。
 */
export function executeLanding(input: ExecuteInput): LandingResult {
  // 幂等：重复提交直接返回既有批次，不产生第二条当前清单项。
  const duplicate = landingState().batches.find((batch) => batch.requestId === input.requestId)
  if (duplicate) {
    return {
      ok: duplicate.state !== '已失败',
      message: `请求 ${input.requestId} 已提交，批次 ${duplicate.batchId} 状态「${duplicate.state}」，重复提交被幂等拦截`,
      batch: duplicate,
    }
  }
  // 并发护栏：存在未收口批次时拒绝新提交，同一分区并发覆写只允许一个写者；
  // 已中断/待切换批次必须先恢复或等会话结束切换，已失败批次为终态可另行重试。
  const busy = landingState().batches.find(
    (batch) => batch.state === '写入中' || batch.state === '待切换' || batch.state === '已中断',
  )
  if (busy) {
    return {
      ok: false,
      message: `批次 ${busy.batchId} 仍在 ${busy.state}，同一分区并发覆写必须串行，请等它完成或先做恢复`,
      batch: busy,
    }
  }

  const planned = planLanding(input.configId, input.requestId)
  if (!planned.ok || !planned.plan) {
    return { ok: false, message: planned.message }
  }
  const plan = planned.plan
  const batchId = nextId('BATCH')
  const fileSeq = { value: 0 }
  const ext = extensionOf(plan.fileFormat)

  const batch: LandingBatch = {
    batchId,
    requestId: input.requestId,
    configId: plan.configId,
    configNo: plan.configNo,
    outputPath: plan.outputPath,
    partitionStrategy: plan.partitionStrategy,
    fileFormat: plan.fileFormat,
    overwriteMode: plan.overwriteMode,
    switchMode: input.switchMode,
    partitions: plan.partitions,
    state: '写入中',
    attempt: 1,
    switchedPartitions: [],
    pendingPartitions: [],
    appendedPartitions: [],
    conflictIds: [],
    reviewed: false,
    resultDay: todayStamp(),
    version: plan.version,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  }
  commit((draft) => {
    draft.batches.push(batch)
  })

  let interrupted = false
  let writtenCount = 0

  for (const partition of plan.partitions) {
    // 模拟写入失败：该分区停在「失败」，其余分区不写入，上一版完整版本不受影响。
    if (input.inject?.failPartition === partition) {
      commit((draft) => {
        const target = draft.batches.find((item) => item.batchId === batchId)!
        target.state = '已失败'
        target.failPartition = partition
        target.failureMessage = `分区 ${partition} 写入失败，临时文件保留在 .tmp，未顶替上一版`
        target.updatedAt = nowIso()
        draft.files.push({
          fileId: `FILE-${++draft.seq}`,
          batchId,
          configId: plan.configId,
          configNo: plan.configNo,
          partition,
          tempPath: tempPathOf(plan.outputPath, batchId, partition, ext),
          finalPath: finalPathOf(plan.outputPath, partition, ext),
          version: plan.version,
          state: '失败',
          checksum: '',
          sizeBytes: 0,
          checkpoint: false,
          failureMessage: '写入中断，临时文件不完整，禁止进入分区清单',
          createdAt: nowIso(),
          updatedAt: nowIso(),
        })
      })
      return {
        ok: false,
        message: `分区 ${partition} 写入失败：临时文件保留但未切换，上一版完整版本继续可见，可重试恢复`,
        batch: landingState().batches.find((item) => item.batchId === batchId),
      }
    }

    // 模拟进程中断：已完成分区的检查点已落盘，重开后从下一分区接续。
    if (
      typeof input.inject?.interruptAfter === 'number' &&
      writtenCount >= input.inject.interruptAfter
    ) {
      interrupted = true
      commit((draft) => {
        const target = draft.batches.find((item) => item.batchId === batchId)!
        target.state = '已中断'
        target.checkpointPartition = target.switchedPartitions[target.switchedPartitions.length - 1]
          ?? target.appendedPartitions[target.appendedPartitions.length - 1]
        target.updatedAt = nowIso()
      })
      break
    }

    const switchOutcome = writePartition({
      batchId,
      plan,
      partition,
      ext,
      switchMode: input.switchMode,
      fileSeq,
    })
    if (!switchOutcome.ok) {
      return {
        ok: false,
        message: switchOutcome.message,
        batch: landingState().batches.find((item) => item.batchId === batchId),
      }
    }
    writtenCount += 1
  }

  if (interrupted) {
    return {
      ok: false,
      message: `落盘进程中断，检查点停在「${batch.checkpointPartition ?? '尚无完成分区'}」，当天已生成结果已留存，请从最后一次成功位置接续恢复`,
      batch: landingState().batches.find((item) => item.batchId === batchId),
    }
  }

  const finalBatch = landingState().batches.find((item) => item.batchId === batchId)!
  if (input.switchMode === '等旧版本读取会话结束后再切换' && finalBatch.pendingPartitions.length > 0) {
    commit((draft) => {
      const target = draft.batches.find((item) => item.batchId === batchId)!
      target.state = '待切换'
      target.updatedAt = nowIso()
    })
    return {
      ok: true,
      message: `批次 ${batchId} 已完整写入，${finalBatch.pendingPartitions.length} 个分区等旧版本读取会话结束后切换，清单当前仍指向上一完整版本`,
      batch: landingState().batches.find((item) => item.batchId === batchId),
    }
  }

  commit((draft) => {
    const target = draft.batches.find((item) => item.batchId === batchId)!
    target.state = '已切换'
    target.finishedAt = nowIso()
    target.updatedAt = nowIso()
  })
  return {
    ok: true,
    message: `批次 ${batchId} 完成：分区预留、写入与可见版本切换已一起提交，数据落盘分区清单已刷新`,
    batch: landingState().batches.find((item) => item.batchId === batchId),
  }
}

type WritePartitionArg = {
  batchId: string
  plan: LandingPlan
  partition: string
  ext: string
  switchMode: SwitchMode
  fileSeq: { value: number }
}

/**
 * 单分区原子推进：预留临时文件 -> 写入完整内容 -> 切换清单指向（或延后/追加），
 * 旧当前版本同时归档。全部改动在一次 commit 里，外部观察不到中间态。
 */
function writePartition(arg: WritePartitionArg): { ok: boolean; message: string } {
  const { batchId, plan, partition, ext, switchMode, fileSeq } = arg
  let rejected = ''
  commit((draft) => {
    const target = draft.batches.find((item) => item.batchId === batchId)!
    const existing = currentOf(draft, partition)

    // 拒绝覆写：同分区已有当前版本且不是本次自己的文件时，直接拒绝该分区。
    if (plan.overwriteMode === '拒绝覆写' && existing && existing.batchId !== batchId) {
      rejected = `分区 ${partition} 已存在当前版本 ${existing.version}，覆写模式为「拒绝覆写」，本次写入被拒绝`
      target.state = '已失败'
      target.rejected = true
      target.failPartition = partition
      target.failureMessage = rejected
      target.updatedAt = nowIso()
      return
    }

    fileSeq.value += 1
    const file: PartitionFile = {
      fileId: `FILE-${++draft.seq}`,
      batchId,
      configId: plan.configId,
      configNo: plan.configNo,
      partition,
      tempPath: tempPathOf(plan.outputPath, batchId, partition, ext),
      finalPath: finalPathOf(plan.outputPath, partition, ext),
      version: plan.version,
      state: '写入',
      checksum: `ck-${partition.replace(/[^a-z0-9]/gi, '')}-${draft.seq}`,
      sizeBytes: 1024 * (64 + draft.seq % 128),
      checkpoint: false,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
    draft.files.push(file)
    target.updatedAt = nowIso()

    // 追加写：只落完整文件，不改分区指向，不产生新的当前清单项。
    if (plan.overwriteMode === '追加写') {
      file.state = '切换'
      file.checkpoint = true
      target.appendedPartitions.push(partition)
      return
    }

    const session = activeSessionFor(draft, partition)

    // 延后切换：旧版本仍被作业读取，新文件完整但先不进清单，记录待切换与冲突。
    if (switchMode === '等旧版本读取会话结束后再切换' && session) {
      file.state = '写入'
      file.checkpoint = true
      target.pendingPartitions.push(partition)
      const conflict: SwitchConflict = {
        conflictId: `CONF-${++draft.seq}`,
        batchId,
        partition,
        newFileId: file.fileId,
        activeSessionId: session.sessionId,
        mode: switchMode,
        status: '延后切换',
        decision: '会话结束后切换',
        note: '新文件已完整，等旧版本读取会话结束后再切换，避免作业读到半路换版',
        createdAt: nowIso(),
      }
      draft.conflicts.push(conflict)
      target.conflictIds.push(conflict.conflictId)
      return
    }

    // 立即切换（含立即模式下仍有读取会话的情况：记录冲突并按立即路径处置）。
    switchManifest(draft, file, target, session)
  })

  if (rejected) {
    return { ok: false, message: rejected }
  }
  return { ok: true, message: 'ok' }
}

/** 在同一事务内切换分区指向：新文件进清单、旧文件归档；有活跃会话则登记立即切换冲突。 */
function switchManifest(
  draft: ReturnType<typeof landingState>,
  file: PartitionFile,
  target: LandingBatch,
  session: ReadSession | undefined,
): void {
  const existingIndex = draft.manifest.findIndex((item) => item.partition === file.partition)
  const previous = existingIndex >= 0 ? draft.manifest[existingIndex] : undefined
  const entry: PartitionCurrent = {
    partition: file.partition,
    currentFileId: file.fileId,
    version: file.version,
    finalPath: file.finalPath,
    configId: file.configId,
    configNo: file.configNo,
    batchId: file.batchId,
    switchedAt: nowIso(),
    previousFileId: previous?.currentFileId,
  }
  if (existingIndex >= 0) {
    draft.manifest[existingIndex] = entry
  } else {
    draft.manifest.push(entry)
  }
  file.state = '切换'
  file.checkpoint = true
  file.updatedAt = nowIso()
  if (previous) {
    const oldFile = draft.files.find((item) => item.fileId === previous.currentFileId)
    if (oldFile) {
      oldFile.state = '归档'
      oldFile.updatedAt = nowIso()
    }
  }
  target.switchedPartitions.push(file.partition)
  if (session) {
    const conflict: SwitchConflict = {
      conflictId: `CONF-${++draft.seq}`,
      batchId: target.batchId,
      partition: file.partition,
      newFileId: file.fileId,
      activeSessionId: session.sessionId,
      mode: target.switchMode,
      status: '立即切换',
      decision: '立即切换路径',
      note: '完成后立即切换分区指向，旧版本读取会话可能感知到换版，已与延后切换方案比对留痕',
      createdAt: nowIso(),
      resolvedAt: nowIso(),
    }
    draft.conflicts.push(conflict)
    target.conflictIds.push(conflict.conflictId)
  }
}

/** 中断/失败恢复：从最后一次成功位置接续，已完成分区不重写，全部补齐后一次性完成切换。 */
export function recoverLanding(batchId: string): LandingResult {
  const state = landingState()
  const batch = state.batches.find((item) => item.batchId === batchId)
  if (!batch) {
    return { ok: false, message: `没有找到批次 ${batchId}` }
  }
  if (batch.state !== '已中断' && batch.state !== '已失败') {
    return { ok: false, message: `批次 ${batchId} 当前为「${batch.state}」，无需恢复` }
  }
  if (batch.rejected) {
    return { ok: false, message: `批次 ${batchId} 因覆写策略被拒绝，属于终态不可恢复；请调整覆写模式或更换分区后用新请求重提` }
  }

  const ext = extensionOf(batch.fileFormat)
  const done = new Set([...batch.switchedPartitions, ...batch.appendedPartitions])
  const plan: LandingPlan = {
    configId: batch.configId,
    configNo: batch.configNo,
    outputPath: batch.outputPath,
    partitionStrategy: batch.partitionStrategy,
    fileFormat: batch.fileFormat,
    overwriteMode: batch.overwriteMode,
    partitions: batch.partitions,
    version: batch.version,
  }
  const fileSeq = { value: 0 }
  let recoveredAny = false

  for (const partition of batch.partitions) {
    if (done.has(partition)) {
      continue // 检查点之前的完整分区跳过，从最后一次成功位置的下一个接续。
    }
    const outcome = writePartition({ batchId, plan, partition, ext, switchMode: batch.switchMode, fileSeq })
    if (!outcome.ok) {
      return {
        ok: false,
        message: `恢复在分区 ${partition} 再次失败：${outcome.message}，上一版完整版本仍可见`,
        batch: landingState().batches.find((item) => item.batchId === batchId),
      }
    }
    recoveredAny = true
  }

  commit((draft) => {
    const target = draft.batches.find((item) => item.batchId === batchId)!
    target.attempt += 1
    target.failPartition = undefined
    target.failureMessage = undefined
    target.updatedAt = nowIso()
    if (target.pendingPartitions.length > 0) {
      target.state = '待切换'
    } else {
      target.state = '已切换'
      target.finishedAt = nowIso()
    }
  })

  return {
    ok: true,
    message: recoveredAny
      ? `批次 ${batchId} 已从检查点「${batch.checkpointPartition ?? '起点'}」接续完成，分区清单恢复到一致状态`
      : `批次 ${batchId} 没有待恢复分区，已直接收口为完整状态`,
    batch: landingState().batches.find((item) => item.batchId === batchId),
  }
}

/** 数据工程师登记一个旧版本读取会话；会话存活是延后切换的判定依据。 */
export function openReadSession(partition: string, jobName: string): LandingResult {
  const state = landingState()
  const current = currentOf(state, partition)
  if (!current) {
    return { ok: false, message: `分区 ${partition} 还没有当前清单项，无可读取的完整版本` }
  }
  const sessionId = nextId('SESS')
  commit((draft) => {
    const session: ReadSession = {
      sessionId,
      partition,
      fileId: current.currentFileId,
      version: current.version,
      jobName,
      active: true,
      startedAt: nowIso(),
    }
    draft.sessions.push(session)
  })
  return { ok: true, message: `读取会话 ${sessionId} 已打开，锁定版本 ${current.version}` }
}

/** 读取会话结束：若有等待中的完整新版本，立即在同事务切换分区指向并归档旧版。 */
export function closeReadSession(sessionId: string): LandingResult {
  const state = landingState()
  const session = state.sessions.find((item) => item.sessionId === sessionId)
  if (!session) {
    return { ok: false, message: `没有找到读取会话 ${sessionId}` }
  }
  if (!session.active) {
    return { ok: false, message: `读取会话 ${sessionId} 已结束，请勿重复关闭` }
  }

  let switched = false
  commit((draft) => {
    const targetSession = draft.sessions.find((item) => item.sessionId === sessionId)!
    targetSession.active = false
    targetSession.endedAt = nowIso()

    // 找等待该分区切换的新文件：同一分区只允许一个待切换版本胜出，取最新批次。
    const pendingFile = [...draft.files]
      .reverse()
      .find((file) => file.partition === session.partition && file.state === '写入' && file.checkpoint)
    if (!pendingFile) {
      return
    }
    const batch = draft.batches.find((item) => item.batchId === pendingFile.batchId)!
    batch.pendingPartitions = batch.pendingPartitions.filter((item) => item !== session.partition)
    if (!batch.switchedPartitions.includes(session.partition)) {
      batch.switchedPartitions.push(session.partition)
    }
    batch.updatedAt = nowIso()
    switchManifest(draft, pendingFile, batch, undefined)
    switched = true

    // 延后冲突在会话结束时收口。
    const conflict = draft.conflicts.find(
      (item) => item.batchId === pendingFile.batchId && item.partition === session.partition && item.status === '延后切换',
    )
    if (conflict) {
      conflict.status = '立即切换'
      conflict.decision = '会话结束后切换'
      conflict.resolvedAt = nowIso()
      conflict.note = '读取会话已结束，按延后方案完成分区指向切换'
    }

    if (batch.pendingPartitions.length === 0 && batch.state === '待切换') {
      batch.state = '已切换'
      batch.finishedAt = nowIso()
    }
    if (batch.state === '写入中' && batch.pendingPartitions.length === 0
      && batch.switchedPartitions.length + batch.appendedPartitions.length === batch.partitions.length) {
      batch.state = '已切换'
      batch.finishedAt = nowIso()
    }
  })

  return {
    ok: true,
    message: switched
      ? `会话 ${sessionId} 结束，等待中的新版本已切换，分区指向完成刷新`
      : `会话 ${sessionId} 已结束，该分区没有待切换版本`,
  }
}

/** 冲突仲裁：比较两种处置的文件可见时间，判定结果校验状态，清单供复核。 */
export function resolveConflict(conflictId: string, decision: ConflictDecision): LandingResult {
  const state = landingState()
  const conflict = state.conflicts.find((item) => item.conflictId === conflictId)
  if (!conflict) {
    return { ok: false, message: `没有找到冲突 ${conflictId}` }
  }
  if (conflict.status === '立即切换' && conflict.resolvedAt) {
    return { ok: false, message: `冲突 ${conflictId} 已按「${conflict.decision}」处置完成` }
  }
  commit((draft) => {
    const target = draft.conflicts.find((item) => item.conflictId === conflictId)!
    target.decision = decision
    target.resolvedAt = nowIso()
    if (decision === '立即切换路径') {
      target.status = '立即切换'
      target.note = '仲裁选择立即切换路径：文件可见时间最早，风险是活跃读取会话可能感知换版'
      const pending = draft.files.find(
        (file) => file.batchId === target.batchId && file.partition === target.partition && file.state === '写入',
      )
      if (pending) {
        const batch = draft.batches.find((item) => item.batchId === target.batchId)!
        batch.pendingPartitions = batch.pendingPartitions.filter((item) => item !== target.partition)
        if (!batch.switchedPartitions.includes(target.partition)) {
          batch.switchedPartitions.push(target.partition)
        }
        switchManifest(draft, pending, batch, undefined)
        if (batch.pendingPartitions.length === 0) {
          batch.state = '已切换'
          batch.finishedAt = nowIso()
        }
      }
    } else {
      target.status = '延后切换'
      target.note = '仲裁选择会话结束后切换：可见时间推迟，但读取会话期间版本稳定'
    }
  })
  return { ok: true, message: `冲突 ${conflictId} 已按「${decision}」记录处置，等待结果校验判定` }
}

/**
 * 结果校验：读取数据落盘分区清单确认目标批次已完整可见；
 * 未完成/待切换分区不进入校验范围，失败批次直接驳回。
 */
export function verifyBatch(batchId: string, pass: boolean): LandingResult {
  const state = landingState()
  const batch = state.batches.find((item) => item.batchId === batchId)
  if (!batch) {
    return { ok: false, message: `没有找到批次 ${batchId}` }
  }
  if (batch.state === '已失败' || batch.state === '已中断') {
    return { ok: false, message: `批次 ${batchId} 处于「${batch.state}」，未完成分区不进入校验范围` }
  }
  if (batch.pendingPartitions.length > 0) {
    return { ok: false, message: `批次 ${batchId} 还有 ${batch.pendingPartitions.length} 个分区等待读取会话结束后切换，目标批次未完整可见` }
  }
  // 完整可见判定：本批次每个分区的文件都已完整落盘（带检查点、非失败/半文件），
  // 且分区在清单里有当前项。即使后来被更新版本顶替、本批次文件已归档，仍属完整版本。
  const visible = batch.partitions.every((partition) => {
    const manifestHas = state.manifest.some((item) => item.partition === partition)
    if (batch.appendedPartitions.includes(partition)) {
      return manifestHas
    }
    const file = state.files.find(
      (item) => item.batchId === batchId && item.partition === partition,
    )
    const fileComplete = !!file && file.checkpoint && file.state !== '失败' && file.state !== '预留'
    return manifestHas && fileComplete
  })
  if (!visible) {
    return { ok: false, message: '分区清单里该批次仍有未切换分区，目标批次未完整可见，暂不受理校验' }
  }
  commit((draft) => {
    const target = draft.batches.find((item) => item.batchId === batchId)!
    target.verified = pass ? '通过' : '驳回'
    target.verifyMessage = pass
      ? '结果校验通过：数据落盘分区清单确认目标批次完整可见，复核依据为完成后立即切换分区指向。'
      : '结果校验驳回：清单版本与预期不一致，数据落盘分区清单已留痕供复核。'
    target.updatedAt = nowIso()
    // 冲突单同步校验状态，供复核比对两种处置。
    draft.conflicts
      .filter((item) => item.batchId === batchId)
      .forEach((item) => {
        item.verifyStatus = pass ? '通过' : '驳回'
      })
  })
  return {
    ok: pass,
    message: pass
      ? `批次 ${batchId} 校验通过，分区清单确认全部目标分区完整可见`
      : `批次 ${batchId} 校验驳回，冲突处置与清单快照已留存供复核`,
    batch: landingState().batches.find((item) => item.batchId === batchId),
  }
}

/** 复核：仅校验通过的批次可复核，复核后状态固化，清单作为最终形态呈现给数据落盘用户。 */
export function reviewBatch(batchId: string): LandingResult {
  const state = landingState()
  const batch = state.batches.find((item) => item.batchId === batchId)
  if (!batch) {
    return { ok: false, message: `没有找到批次 ${batchId}` }
  }
  if (batch.verified !== '通过') {
    return { ok: false, message: '仅结果校验通过的批次可以复核，请先完成结果校验' }
  }
  commit((draft) => {
    const target = draft.batches.find((item) => item.batchId === batchId)!
    target.reviewed = true
    target.state = '已复核'
    target.updatedAt = nowIso()
  })
  return { ok: true, message: `批次 ${batchId} 已复核，数据落盘分区清单即为最终可见形态` }
}

export function listBatches(): LandingBatch[] {
  return landingState().batches
}

export function listManifest(): PartitionCurrent[] {
  return landingState().manifest
}

export function listFiles(): PartitionFile[] {
  return landingState().files
}

export function listSessions(): ReadSession[] {
  return landingState().sessions
}

export function listConflicts(): SwitchConflict[] {
  return landingState().conflicts
}

export function landingStats(): LandingStats {
  const state = landingState()
  return {
    batchCount: state.batches.length,
    manifestCount: state.manifest.length,
    visiblePartitionCount: state.manifest.length,
    pendingSwitchCount: state.batches.reduce((sum, batch) => sum + batch.pendingPartitions.length, 0),
    activeConflictCount: state.conflicts.filter((item) => !item.resolvedAt || item.status === '延后切换').length,
    failedFileCount: state.files.filter((file) => file.state === '失败').length,
    activeSessionCount: state.sessions.filter((session) => session.active).length,
  }
}

export function resetLandingState(): LandingResult {
  resetLanding()
  return { ok: true, message: '原子落盘演示数据已重置为初始完整版本' }
}

/**
 * 原子落盘领域模型。
 *
 * 真实链路里这部分由文件系统 + 元数据服务承担，纯前端版用 localStorage 模拟同一份语义：
 * - 分区文件经历 预留 -> 写入 -> 切换 -> 归档 的状态流转，写入失败停在 失败，永远不进清单；
 * - 数据落盘分区清单（manifest）只登记完整可见版本，下游只读清单、不碰临时目录；
 * - 同一分区的预留、写入、可见版本切换在一次持久化事务里完成，保证看不到半个文件。
 */

/** 分区文件状态：预留、写入、切换、归档、失败。恢复时清单永远指回最后完整版本。 */
export type PartitionFileState = '预留' | '写入' | '切换' | '归档' | '失败'

/** 可见版本切换方式。 */
export type SwitchMode =
  | '完成后立即切换分区指向'
  | '等旧版本读取会话结束后再切换'

/** 覆写模式：同一分区并发覆写时的胜出规则。 */
export type OverwriteMode =
  | '原子覆写' // 同分区仅保留一个当前版本，新版本完整落盘后顶替旧版本
  | '拒绝覆写' // 同分区已存在当前版本时直接拒绝，不允许顶替
  | '追加写' // 写新文件但不改分区指向，当前版本保持不变

/** 落盘批次状态。 */
export type BatchState =
  | '写入中'
  | '已中断'
  | '待切换'
  | '已切换'
  | '已失败'
  | '已复核'

/** 冲突处置：比较「立即切换路径」与「会话结束后切换」两种可见时间。 */
export type ConflictDecision = '立即切换路径' | '会话结束后切换'

export type ConflictStatus = '待处理' | '立即切换' | '延后切换'

/** 分区文件：临时文件与完整版本文件的载体。 */
export type PartitionFile = {
  fileId: string
  batchId: string
  configId: number
  configNo: string
  partition: string
  /** 临时文件路径，写入期间只存在于 .tmp 目录，下游不可见。 */
  tempPath: string
  /** 完整版本路径，切换后才进入分区清单。 */
  finalPath: string
  version: string
  state: PartitionFileState
  checksum: string
  sizeBytes: number
  /** 恢复接续点：已记录的完成位置，中断后从它后面接续。 */
  checkpoint: boolean
  failureMessage?: string
  createdAt: string
  updatedAt: string
}

/** 数据落盘分区清单条目：每个分区至多一条当前项，下游只看到这里的完整文件。 */
export type PartitionCurrent = {
  partition: string
  currentFileId: string
  version: string
  finalPath: string
  configId: number
  configNo: string
  batchId: string
  switchedAt: string
  previousFileId?: string
}

/** 旧版本读取会话：会话存活期间可要求分区指向延后切换。 */
export type ReadSession = {
  sessionId: string
  partition: string
  fileId: string
  version: string
  jobName: string
  active: boolean
  startedAt: string
  endedAt?: string
}

/** 切换冲突：新文件即将完成而旧文件仍被作业读取时产生。 */
export type SwitchConflict = {
  conflictId: string
  batchId: string
  partition: string
  newFileId: string
  activeSessionId: string
  mode: SwitchMode
  status: ConflictStatus
  decision?: ConflictDecision
  /** 结果校验对两种处置的判定，供复核。 */
  verifyStatus?: '通过' | '驳回'
  note?: string
  createdAt: string
  resolvedAt?: string
}

/** 落盘批次：一次原子落盘提交的完整轨迹。 */
export type LandingBatch = {
  batchId: string
  /** 幂等键：重复提交复用同一批次，不会生成两个当前清单项。 */
  requestId: string
  configId: number
  configNo: string
  /** 主数据快照：数据落盘、配置编号与存储配置，配置编号可追溯。 */
  outputPath: string
  partitionStrategy: string
  fileFormat: string
  overwriteMode: OverwriteMode
  switchMode: SwitchMode
  partitions: string[]
  state: BatchState
  attempt: number
  /** 最后一次成功位置（分区名），中断恢复从这里接续。 */
  checkpointPartition?: string
  switchedPartitions: string[]
  pendingPartitions: string[]
  appendedPartitions: string[]
  conflictIds: string[]
  failPartition?: string
  failureMessage?: string
  /** 策略拒绝（如拒绝覆写）：终态，不允许检查点恢复，需换请求或换分区重提。 */
  rejected?: boolean
  /** 结果校验状态；未完成分区不进入校验范围。 */
  verified?: '通过' | '驳回'
  verifyMessage?: string
  reviewed: boolean
  /** 当天生成结果留存标记。 */
  resultDay: string
  version: string
  createdAt: string
  updatedAt: string
  finishedAt?: string
}

/** 失败注入：用于演示半文件防护与中断恢复。 */
export type InjectOptions = {
  /** 写入到该分区时模拟失败。 */
  failPartition?: string
  /** 写完 N 个分区后模拟进程中断。 */
  interruptAfter?: number
}

export type LandingResult = {
  ok: boolean
  message: string
  batch?: LandingBatch
}

export type LandingStats = {
  batchCount: number
  manifestCount: number
  visiblePartitionCount: number
  pendingSwitchCount: number
  activeConflictCount: number
  failedFileCount: number
  activeSessionCount: number
}

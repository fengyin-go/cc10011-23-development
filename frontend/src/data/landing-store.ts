import type {
  LandingBatch,
  PartitionCurrent,
  PartitionFile,
  ReadSession,
  SwitchConflict,
} from './landing-types'

/**
 * 原子落盘独立持久化：与业务条目（scraper-strategy-studio:entries）分开存放，
 * resetModule 清配置不会抹掉分区清单，清单是下游作业的可见性依据。
 */
const LANDING_KEY = 'scraper-strategy-studio:landing'

export type LandingState = {
  files: PartitionFile[]
  manifest: PartitionCurrent[]
  sessions: ReadSession[]
  conflicts: SwitchConflict[]
  batches: LandingBatch[]
  seq: number
}

function todayStamp(): string {
  return new Date().toISOString().slice(0, 10)
}

function nowIso(): string {
  return new Date().toISOString()
}

/** 初始状态：已有一条完整可见的落盘批次，清单指向它的当前版本，下游可以直接读。 */
export function seedLandingState(): LandingState {
  const day = todayStamp()
  const at = nowIso()
  const version = `v20261117-0100-r1`
  const partitions = ['dt=2026-11-17/region=east', 'dt=2026-11-17/region=south']
  const files: PartitionFile[] = partitions.map((partition, index) => ({
    fileId: `FILE-INIT-${index + 1}`,
    batchId: 'BATCH-INIT',
    configId: 3,
    configNo: 'STOR-0003',
    partition,
    tempPath: `/data/warehouse/orders/.tmp/BATCH-INIT/${partition}/part-r${index + 1}.parquet.tmp`,
    finalPath: `/data/warehouse/orders/${partition}/part-r${index + 1}.parquet`,
    version,
    state: '切换',
    checksum: `ck-${partition.replace(/[^a-z0-9]/gi, '')}-100`,
    sizeBytes: 1024 * 128,
    checkpoint: true,
    createdAt: at,
    updatedAt: at,
  }))
  const manifest: PartitionCurrent[] = files.map((file) => ({
    partition: file.partition,
    currentFileId: file.fileId,
    version: file.version,
    finalPath: file.finalPath,
    configId: file.configId,
    configNo: file.configNo,
    batchId: file.batchId,
    switchedAt: at,
  }))
  const batches: LandingBatch[] = [
    {
      batchId: 'BATCH-INIT',
      requestId: 'seed-request-0000',
      configId: 3,
      configNo: 'STOR-0003',
      outputPath: '/data/warehouse/orders',
      partitionStrategy: '按日分区',
      fileFormat: 'Parquet',
      overwriteMode: '原子覆写',
      switchMode: '完成后立即切换分区指向',
      partitions,
      state: '已复核',
      attempt: 1,
      switchedPartitions: partitions,
      pendingPartitions: [],
      appendedPartitions: [],
      conflictIds: [],
      verified: '通过',
      verifyMessage: '初始化完整版本，复核依据：完成后立即切换分区指向。',
      reviewed: true,
      resultDay: day,
      version,
      createdAt: at,
      updatedAt: at,
      finishedAt: at,
    },
  ]
  return { files, manifest, sessions: [], conflicts: [], batches, seq: 100 }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

let cache: LandingState | null = null

function readState(): LandingState {
  const fallback = seedLandingState()
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(LANDING_KEY)
  if (!raw) {
    window.localStorage.setItem(LANDING_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    return JSON.parse(raw) as LandingState
  } catch {
    window.localStorage.setItem(LANDING_KEY, JSON.stringify(fallback))
    return fallback
  }
}

export function landingState(): LandingState {
  if (cache === null) {
    cache = readState()
  }
  return cache
}

/**
 * 事务持久化：调用方在 draft 上一次性完成「预留/写入/切换/归档」的全部改动，
 * 这里只做一次 localStorage 写入——要么整体生效，要么整体不生效，
 * 不会出现临时文件顶替上一版、或清单里出现半个分区的情况。
 */
export function commit(mutator: (draft: LandingState) => void): LandingState {
  const draft = clone(landingState())
  mutator(draft)
  cache = draft
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(LANDING_KEY, JSON.stringify(draft))
  }
  return draft
}

export function resetLanding(): LandingState {
  const fresh = seedLandingState()
  cache = fresh
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(LANDING_KEY, JSON.stringify(fresh))
  }
  return fresh
}

export function nextId(prefix: string): string {
  const draft = landingState()
  draft.seq += 1
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(LANDING_KEY, JSON.stringify(draft))
  }
  return `${prefix}-${draft.seq}`
}

export function landingStorageKey(): string {
  return LANDING_KEY
}

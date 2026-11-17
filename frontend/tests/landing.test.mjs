/**
 * 原子落盘引擎的无头仿真测试：用内存 localStorage 垫片在 Node 里跑完整业务路径。
 * 运行：node tests/run-landing-tests.mjs（由 Makefile 目标或手工 esbuild 打包后执行）。
 */

function makeLocalStorage() {
  const map = new Map()
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    clear: () => map.clear(),
  }
}

// 模块加载前装好浏览器垫片。
globalThis.window = { localStorage: makeLocalStorage() }

const svc = await import('./landing-service.bundle.js')

let passed = 0
let failed = 0
function check(name, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.error(`  ✗ ${name} ${detail}`)
  }
}

function manifestFor(partition) {
  return svc.listManifest().find((item) => item.partition === partition)
}

function findBatch(batchId) {
  return svc.listBatches().find((item) => item.batchId === batchId)
}

const dayPartitions = svc.planLanding(3).plan.partitions

// ---------- 场景 1：正常原子落盘，完整版本顶替初始版本 ----------
console.log('场景1 正常原子落盘：预留/写入/切换同事务完成')
{
  const before = manifestFor(dayPartitions[0])
  const r = svc.executeLanding({
    configId: 3,
    requestId: 'req-normal-1',
    switchMode: '完成后立即切换分区指向',
  })
  check('执行成功', r.ok, r.message)
  const batch = r.batch
  const afterEast = manifestFor(dayPartitions[0])
  check('清单指向新版本', afterEast.version === batch.version, afterEast.version)
  check('清单来源批次已更新', afterEast.batchId === batch.batchId)
  check('旧版本文件已归档', svc.listFiles().some(
    (f) => f.fileId === before.currentFileId && f.state === '归档'))
  check('每个分区只有一个当前清单项',
    svc.listManifest().filter((m) => m.partition === dayPartitions[0]).length === 1)
  check('新文件均处于切换态且带检查点', svc.listFiles()
    .filter((f) => f.batchId === batch.batchId)
    .every((f) => f.state === '切换' && f.checkpoint))
  check('批次收口为已切换', batch.state === '已切换')
}

// ---------- 场景 2：幂等，重复提交不生成两个当前项 ----------
console.log('场景2 幂等提交：重复 requestId 被拦截')
{
  const manifestCountBefore = svc.listManifest().length
  const dup = svc.executeLanding({
    configId: 3,
    requestId: 'req-normal-1',
    switchMode: '完成后立即切换分区指向',
  })
  check('重复提交返回幂等回执', dup.ok === true)
  check('清单条目数不变', svc.listManifest().length === manifestCountBefore)
  check('批次总数不增加', svc.listBatches().filter((b) => b.requestId === 'req-normal-1').length === 1)
}

// ---------- 场景 3：写入失败，临时文件不顶替上一版 ----------
console.log('场景3 写入失败：半文件防护，上一版继续可见')
{
  const before = manifestFor(dayPartitions[1])
  const r = svc.executeLanding({
    configId: 3,
    requestId: 'req-fail-1',
    switchMode: '完成后立即切换分区指向',
    inject: { failPartition: svc.planLanding(3).plan.partitions[1] },
  })
  check('失败结果返回 false', r.ok === false)
  const batch = r.batch
  check('批次标记已失败', batch.state === '已失败')
  const failedFile = svc.listFiles().find((f) => f.batchId === batch.batchId && f.state === '失败')
  check('失败临时文件存在且无校验和', !!failedFile && failedFile.checksum === '')
  check('失败文件没有进入清单', !svc.listManifest().some((m) => m.currentFileId === failedFile?.fileId))
  const after = manifestFor(dayPartitions[1])
  check('上一版完整版本仍然可见', after.currentFileId === before.currentFileId)
}

// ---------- 场景 4：失败后恢复，从最后成功位置接续 ----------
console.log('场景4 失败恢复：清单回到一致的完整状态')
{
  const failedBatch = svc.listBatches().find((b) => b.requestId === 'req-fail-1')
  const r = svc.recoverLanding(failedBatch.batchId)
  check('恢复成功', r.ok, r.message)
  const batch = findBatch(failedBatch.batchId)
  check('恢复后批次已切换', batch.state === '已切换')
  check('所有分区都在清单指向该批次',
    batch.partitions.every((p) => manifestFor(p)?.batchId === batch.batchId))
  check('尝试次数递增为 2', batch.attempt === 2)
}

// ---------- 场景 5：进程中断，检查点接续 ----------
console.log('场景5 进程中断：从最后一次成功位置接续，当天结果留存')
{
  const r = svc.executeLanding({
    configId: 3,
    requestId: 'req-interrupt-1',
    switchMode: '完成后立即切换分区指向',
    inject: { interruptAfter: 1 },
  })
  check('中断返回失败提示', r.ok === false)
  const batch = r.batch
  check('批次标记已中断', batch.state === '已中断')
  check('检查点记录最后成功分区', batch.checkpointPartition === batch.partitions[0])
  check('已完成分区当天已留存且可见', manifestFor(batch.partitions[0])?.batchId === batch.batchId)
  check('未完成分区不在该批次清单下', manifestFor(batch.partitions[1])?.batchId !== batch.batchId)

  const rec = svc.recoverLanding(batch.batchId)
  check('接续恢复成功', rec.ok, rec.message)
  const done = findBatch(batch.batchId)
  check('恢复跳过已完成分区（切换数=总分区数）',
    done.switchedPartitions.length === done.partitions.length)
  check('恢复后整体完整可见',
    done.partitions.every((p) => manifestFor(p)?.batchId === done.batchId))
}

// ---------- 场景 6：读取会话 + 延后切换，会话结束后刷新指向 ----------
console.log('场景6 延后切换：等旧版本读取会话结束后再切换')
{
  const partition = dayPartitions[2]
  const before = manifestFor(partition)
  const open = svc.openReadSession(partition, 'bi-report-job')
  check('读取会话打开成功', open.ok, open.message)
  const session = svc.listSessions().find((s) => s.partition === partition && s.active)

  const r = svc.executeLanding({
    configId: 3,
    requestId: 'req-defer-1',
    switchMode: '等旧版本读取会话结束后再切换',
  })
  check('延后批次整体写入成功', r.ok)
  const batch = r.batch
  check('该分区进入待切换', batch.pendingPartitions.includes(partition))
  check('清单仍指向上一完整版本', manifestFor(partition).currentFileId === before.currentFileId)
  check('产生延后切换冲突单', svc.listConflicts().some(
    (c) => c.batchId === batch.batchId && c.partition === partition && c.status === '延后切换'))
  check('新文件完整但未进清单（写入态+检查点）', svc.listFiles().some(
    (f) => f.batchId === batch.batchId && f.partition === partition && f.state === '写入' && f.checkpoint))

  const close = svc.closeReadSession(session.sessionId)
  check('会话结束成功', close.ok, close.message)
  check('会话结束后清单切换到新版本', manifestFor(partition).batchId === batch.batchId)
  check('旧文件归档', svc.listFiles().some((f) => f.fileId === before.currentFileId && f.state === '归档'))
  const done = findBatch(batch.batchId)
  check('批次收口已切换', done.state === '已切换')
}

// ---------- 场景 7：立即切换遇到活跃会话，冲突留痕并可仲裁 ----------
console.log('场景7 立即切换冲突：两种处置比对与仲裁')
{
  const partition = dayPartitions[0]
  svc.openReadSession(partition, 'realtime-job')
  const r = svc.executeLanding({
    configId: 3,
    requestId: 'req-immediate-conflict-1',
    switchMode: '完成后立即切换分区指向',
  })
  check('立即模式照常完成', r.ok)
  const conflict = svc.listConflicts().find(
    (c) => c.batchId === r.batch.batchId && c.partition === partition)
  check('立即切换冲突已登记', !!conflict && conflict.decision === '立即切换路径')

  // 延后模式再制造一个未决冲突，手工仲裁为立即路径
  const partition2 = dayPartitions[1]
  svc.openReadSession(partition2, 'another-job')
  const r2 = svc.executeLanding({
    configId: 3,
    requestId: 'req-arbitrate-1',
    switchMode: '等旧版本读取会话结束后再切换',
  })
  // 同批次可能在多个分区各有一个延后冲突，按目标分区精确取单。
  const c2 = svc.listConflicts().find(
    (c) => c.batchId === r2.batch.batchId && c.partition === partition2 && c.status === '延后切换')
  check('延后冲突待仲裁', !!c2)
  const arb = svc.resolveConflict(c2.conflictId, '立即切换路径')
  check('仲裁成功', arb.ok, arb.message)
  check('仲裁后分区立即指向新批次', manifestFor(partition2).batchId === r2.batch.batchId)

  // 收口：结束其余活跃读取会话，让批次其余待切换分区全部完成切换，避免污染后续场景。
  for (const session of svc.listSessions().filter((s) => s.active)) {
    svc.closeReadSession(session.sessionId)
  }
  check('冲突批次全部收口为已切换', findBatch(r2.batch.batchId).state === '已切换')
}

// ---------- 场景 8：结果校验门 + 复核 ----------
console.log('场景8 结果校验：未完成分区不进校，复核固化最终形态')
{
  // 制造一个中断批次，校验必须被拒绝
  const blocked = svc.executeLanding({
    configId: 3,
    requestId: 'req-verify-block-1',
    switchMode: '完成后立即切换分区指向',
    inject: { interruptAfter: 1 },
  })
  const v1 = svc.verifyBatch(blocked.batch.batchId, true)
  check('中断批次不进入校验范围', v1.ok === false)

  svc.recoverLanding(blocked.batch.batchId)
  const v2 = svc.verifyBatch(blocked.batch.batchId, true)
  check('恢复完整后校验通过', v2.ok, v2.message)
  const rv = svc.reviewBatch(blocked.batch.batchId)
  check('复核成功', rv.ok)
  check('批次固化为已复核', findBatch(blocked.batch.batchId).state === '已复核')

  const rvEarly = svc.reviewBatch('BATCH-INIT')
  check('初始批次已复核可重复查询不报错状态', rvEarly.ok === true)
}

// ---------- 场景 9：覆写模式 ----------
console.log('场景9 覆写模式：拒绝覆写 / 追加写')
{
  // 配置 2 是拒绝覆写，且其分区策略为按小时分区（新分区，先写一版占位）
  const first = svc.executeLanding({
    configId: 2,
    requestId: 'req-reject-1',
    switchMode: '完成后立即切换分区指向',
  })
  check('拒绝覆写模式首版写入成功', first.ok, first.message)
  const again = svc.executeLanding({
    configId: 2,
    requestId: 'req-reject-2',
    switchMode: '完成后立即切换分区指向',
  })
  check('同分区再次覆写被拒绝', again.ok === false && again.batch.state === '已失败' && again.batch.rejected === true)
  const partition = first.batch.partitions[0]
  check('清单仍指向首版', manifestFor(partition).batchId === first.batch.batchId)
  const recoverRejected = svc.recoverLanding(again.batch.batchId)
  check('策略拒绝为终态，不允许检查点恢复', recoverRejected.ok === false)
}

// ---------- 场景 10：并发护栏 ----------
console.log('场景10 并发护栏：写入中批次未结束时拒绝新提交')
{
  const busy = svc.executeLanding({
    configId: 3,
    requestId: 'req-busy-1',
    switchMode: '完成后立即切换分区指向',
    inject: { interruptAfter: 1 },
  })
  const concurrent = svc.executeLanding({
    configId: 3,
    requestId: 'req-busy-2',
    switchMode: '完成后立即切换分区指向',
  })
  check('并发覆写被串行护栏拦截', concurrent.ok === false)
  svc.recoverLanding(busy.batch.batchId)
  check('护栏批次恢复后可继续', findBatch(busy.batch.batchId).state === '已切换')
}

console.log(`\n结果：通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)

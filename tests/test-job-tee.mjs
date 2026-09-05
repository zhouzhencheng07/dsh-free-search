// job-tee 双游标分流单测（src/job-tee.ts）。
// 场景：官方 job.readOutput 是单游标增量（每次调用返回"自上次调用以来"的新块），
// tee 后模型（包装后的 readOutput）与面板（panelReadJobOutput）各持独立游标，
// 任何一方读取都不得让对方丢量。用法（dsh-kit 根）：node tests\test-job-tee.mjs
import { installJobTee, panelReadJobOutput, teeRegistryJobs } from '../src/job-tee.ts'

let failed = 0
const check = (label, cond) => {
  console.log(`${cond ? "PASS  " : "FAIL  "}${label}`)
  if (!cond) failed++
}

/** 造一个带单游标 readOutput 的 job：producer 每产出一段，readOutput 就多吐一段。 */
function makeJob(producer) {
  return { id: 'pwsh-1', status: 'running', readOutput: () => producer.shift() ?? '' }
}

// 1) 面板不参与时，模型路径与原版逐位一致：读一次拿一段
{
  const job = makeJob(['a', 'b', 'c'])
  installJobTee(job)
  check('仅模型读：第一段 a', job.readOutput() === 'a')
  check('仅模型读：第二段 b', job.readOutput() === 'b')
  check('仅模型读：第三段 c', job.readOutput() === 'c')
  check('仅模型读：读空后空串', job.readOutput() === '')
}

// 2) 面板读取不抢模型增量：模型读过的，面板下次读补不上；模型没读的，面板读走后模型照样能读到
{
  const job = makeJob(['a', 'b', 'c'])
  installJobTee(job)
  check('模型读 a', job.readOutput() === 'a')
  check('面板首读从头拿全量 ab（含模型已读前缀）', panelReadJobOutput(job) === 'ab')
  check('面板再读拿 c（模型尚未读）', panelReadJobOutput(job) === 'c')
  check('模型再读 bc——面板读走的量不丢，自模型上次读取以来的增量完整', job.readOutput() === 'bc')
}

// 3) 模型读取不丢面板已读的量（每次读取都会先排水，切片起点只看各自游标）
{
  const job = makeJob(['a', 'b', 'c'])
  installJobTee(job)
  check('面板读 a', panelReadJobOutput(job) === 'a')
  check('模型读 ab——面板读走的 a 与新块 b 一起到', job.readOutput() === 'ab')
  check('模型再读 c', job.readOutput() === 'c')
}

// 4) 安装幂等：重复 install 不会二次包装（模型游标不被双份切片）
{
  const job = makeJob(['x', 'y'])
  installJobTee(job)
  installJobTee(job)
  check('幂等：模型读 x', job.readOutput() === 'x')
  check('幂等：模型读 y（无重复消费）', job.readOutput() === 'y')
}

// 5) 无 readOutput 的任务：运行中空串，终态回落 outcome.output（官方语义）
{
  const job = { id: 'k-1', status: 'running', output: undefined }
  check('无 readOutput 运行中：空串', panelReadJobOutput(job) === '')
  job.status = 'completed'
  job.output = 'final output'
  check('无 readOutput 终态：回落 output', panelReadJobOutput(job) === 'final output')
}

// 6) teeRegistryJobs：创建即装分身——新 job 的 readOutput 已是包装版（走 buffer 切片）
{
  const store = new Map()
  let n = 0
  const registry = {
    store,
    start(spec) {
      n += 1
      const job = { id: `${spec.kind}-${n}`, status: 'running', readOutput: () => (spec.pull ?? (() => ''))() }
      store.set(job.id, job)
      return job.id
    },
  }
  teeRegistryJobs(registry)
  const pulled = []
  const id = registry.start({ kind: 'pwsh', pull: () => pulled.shift() ?? '' })
  const job = store.get(id)
  pulled.push('p1')
  check('start 包装：模型读经 tee（p1）', job.readOutput() === 'p1')
  pulled.push('p2')
  check('start 包装：面板首读全量 p1p2', panelReadJobOutput(job) === 'p1p2')
  pulled.push('p3')
  check('start 包装：模型再读 p2p3（互不抢量）', job.readOutput() === 'p2p3')
}

// 7) registry 形状不符时静默不装（不抛错）
{
  teeRegistryJobs({})
  teeRegistryJobs({ start: () => 'x' })
  check('形状不符静默不装', true)
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAIL`)
process.exit(failed === 0 ? 0 : 1)

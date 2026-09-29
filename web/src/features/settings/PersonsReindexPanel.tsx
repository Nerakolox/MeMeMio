import { useState } from 'react'
import { Info } from 'lucide-react'
import { ApiError } from '../../lib/api'
import {
  fetchPersonReindexStatus,
  startPersonReindex,
  type PersonReindexStatus,
} from '../../lib/api-persons'
import { Alert, AlertDescription, AlertTitle } from '../../components/ui/alert'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Progress } from '../../components/ui/progress'
import { SettingsCard } from './SettingsCard'
import { pollProblemText, usePolledStatus } from './use-poll-status'
import { TOUCH } from './settings-ui'

/**
 * 存量人物向量的补跑与进度（任务 §5.2、SPEC §6.7.5）。
 *
 * ## 与文本那份 `ReindexPanel` 的关键差别：**点之前要说清条数和花谁的钱**
 *
 * 文本重算一条是「一次导入里的一张图」，而**这里每张图都是一次付费的上游调用**。
 * 所以这一张卡多一段放在按钮**上面**的话：先说看到多少张待重算，再说这些钱归谁
 * （部署方），最后说「新图会自动算，不用点」。任务 §5.2 把这句列成硬要求。
 *
 * ## 「多少张」只能说到看得见的那部分
 *
 * 补跑排的是「所有未软删、**没有当前口径向量**的图」，这里面有两类：
 * 库里记着旧模型向量的（`stale`，**这里数得出来**），以及从来没算过向量的
 * （接口不单独给这个数，它也不是「stale」）。所以文案不能把 `stale` 说成总数——
 * 那是**一个偏小的数**，按它报账会低估这笔开销。说成「至少」才是诚实的。
 *
 * ## 第一次配好不自动补跑
 *
 * 这是有意的（§6.7.5）：每张一张钱，不能由「保存配置」这个动作静默触发。
 * 所以这张卡在没人点的时候也不能显得像「已经排上了」——`enqueuedCount` 为 0 时
 * 那句话必须说清是「没有新排队的」，同 `ReindexPanel`。
 */

type Props = {
  /** 父组件确认换模型后自增，用来立刻重新拉一次状态，不等下一轮轮询 */
  refreshToken: number
}

/** 一格统计。与 `ReindexPanel` 同形——两张卡并排时它们得长得一样。 */
function Count({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-heading text-xl tabular-nums">{value}</dd>
    </div>
  )
}

export function PersonsReindexPanel({ refreshToken }: Props) {
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  /** 这一次点击排进去几条的反馈。**两个分支都要有话**，理由同 `ReindexPanel`。 */
  const [startNote, setStartNote] = useState<string | null>(null)
  const [manualTick, setManualTick] = useState(0)

  const { status, problem } = usePolledStatus<PersonReindexStatus>({
    load: fetchPersonReindexStatus,
    isBusy: (next) => next.running,
    fallbackMessage: '人物向量补算状态读取失败',
    restartKey: `${refreshToken}:${manualTick}`,
  })

  async function handleStart() {
    setStartError(null)
    setStartNote(null)
    setStarting(true)
    try {
      const { enqueuedCount } = await startPersonReindex()
      /*
        `enqueuedCount` 为 0 时界面会和点击前逐像素相同（徽标还是「空闲」、进度还是
        100%、三个计数一动不动），用户只能靠猜按钮生效没有、然后反复点。
        0 也不是失败：该排的早就排上了（幂等，§6.7.5），所以不能写成错误。

        ⚠️ 排进去的那个数**是这里唯一确切的数**（点之前只能给 `stale` 那个偏小的下界），
        所以要说给用户看的是它，不是「已提交」这种没有信息量的回执。
      */
      setStartNote(
        enqueuedCount > 0
          ? `已排队 ${enqueuedCount} 条，进度见上方。每条都是一次上游付费调用，花的是部署方的额度。`
          : '没有新排队的记录——每张图都已经有当前口径的向量了。',
      )
      setManualTick((n) => n + 1)
    } catch (err) {
      setStartError(
        err instanceof ApiError ? `${err.message}（requestId：${err.requestId}）` : '触发失败',
      )
    } finally {
      setStarting(false)
    }
  }

  // total 为 0（库里还没图）时不能除：0/0 会算出 NaN，进度条变成一条空轨
  const percent = status && status.total > 0 ? Math.round((status.done / status.total) * 100) : 0

  return (
    <SettingsCard
      title="补算人物向量"
      description="配好图片向量之后，存量的图不会自动补算——每张都要钱，所以由你决定什么时候开始。"
      action={
        status && (
          <Badge variant={status.running ? 'default' : 'secondary'}>
            {status.running ? '进行中' : '空闲'}
          </Badge>
        )
      }
    >
      {problem !== null && (
        // 中性提示不是错误：连不上服务端不是用户做错了什么，而且它在自己重试（同 ImportProgress）
        <Alert role="status">
          <Info />
          <AlertDescription>
            {pollProblemText(problem)}
            {problem.requestId !== undefined && (
              <span className="mt-1 block font-mono text-xs">
                requestId：{problem.requestId}
              </span>
            )}
          </AlertDescription>
        </Alert>
      )}

      {status && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Progress value={percent} aria-label="人物向量补算进度" />
            <p className="text-sm text-muted-foreground">
              {status.running ? '补算进行中' : '当前没有进行中的补算'}
              {'，'}
              已完成 {percent}%。
              {/* 与检索那条降级路径无关，说一句免得管理员以为它也在拖慢搜索（§6.7.5） */}
              人物向量不参与检索召回，所以补算期间搜索结果不受影响。
            </p>
          </div>

          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Count label="已是当前模型" value={`${status.done} / ${status.total}`} />
            <Count label="待重算" value={String(status.stale)} />
            <Count label="重试耗尽" value={String(status.failed)} />
          </dl>

          {status.failed > 0 && (
            <Alert variant="destructive">
              <AlertTitle>
                有 {status.failed} 条重试耗尽，不做断点续传，需要看服务端日志。
              </AlertTitle>
            </Alert>
          )}
        </div>
      )}

      {/*
        ⚠️ **这一段在按钮之前**，不是按钮下面的注释（任务 §5.2：「点之前说清要排多少张、
        花的是部署方的额度」）。放在下面的话，用户已经点完了才看到「这是在花谁的钱」——
        那不是提示，是事后说明。

        「至少 N 张」里的 N 是 `stale`：**它是个下界不是总数**（见文件头）。没有状态
        （还没拉到）时不给数字，也不编一个。
      */}
      <p className="text-sm text-muted-foreground">
        {'点下去会把所有还没有当前口径向量的图排进队列：'}
        {status ? `这里数得出至少 ${status.stale} 张待重算，另外还有从没算过向量的图，会一起排进来。` : '正在读取张数…'}
        {'每张都是一次上游付费调用，花的是部署方的额度。'}
        {'配好之后新导入的图会自动算，不用点这里。'}
      </p>

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          className={TOUCH}
          onClick={handleStart}
          disabled={starting}
        >
          {starting ? '触发中…' : '补算人物向量'}
        </Button>
      </div>
      {/* 幂等，重复点不会让同一条记录重算两遍（§6.7.5），所以跑着的时候也不禁用 */}
      <p className="text-sm text-muted-foreground">重复触发是安全的：服务端幂等，不会重复排队。</p>

      {startNote && (
        <p role="status" className="text-sm">
          {startNote}
        </p>
      )}

      {startError && (
        <Alert variant="destructive">
          <AlertTitle>{startError}</AlertTitle>
        </Alert>
      )}
    </SettingsCard>
  )
}

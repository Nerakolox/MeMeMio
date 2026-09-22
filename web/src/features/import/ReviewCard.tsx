import type { ReactNode } from 'react'
import { Button } from '../../components/ui/button'
import { Card, CardContent } from '../../components/ui/card'
import type { ReviewItem } from '../../lib/api-imports'
import { formatBytes, formatDate } from '../../lib/format'
import { TOUCH } from '../../lib/touch'

/**
 * 尺寸是**可空的**：服务端在图片管线还没读出宽高时给 null（比如刚 commit、缩略图还没生成）。
 * 直接插值会渲染成「×」，看起来像坏了；给个占位才看得出来是「还没读到」。
 */
function dims(width: number | null, height: number | null): string {
  return width === null || height === null ? '尺寸未知' : `${width}×${height}`
}

/**
 * 并排对比。左右各显示尺寸、大小、上传者、时间，让用户自己判断要不要留（import-ux.md §5）。
 *
 * 三个动作缺一不可——「稍后再说」不是可有可无的：导入一千张后用户不一定有力气
 * 当场判三十个近似重复，强迫他决定只会让他随便点一个。
 *
 * ## 左右两格按**容器**宽度堆叠，不按视口
 *
 * 旧写法是 `@media (max-width: 640px) { grid-template-columns: 1fr }`。加侧边导航之后
 * 视口宽度不再等于内容宽度（差 256px），640px 视口下留给卡片的内容只有约 384px——
 * 两格各 180px，比这条规则自己写的可读底线还窄，而媒体查询在那个区间不会触发。
 * 容器就是这张卡的内容区（`@container` 落在 `CardContent` 上，它真的包住了网格）。
 */
export function ReviewCard({
  item,
  busy,
  error,
  onDecide,
  onLater,
}: {
  item: ReviewItem
  busy: boolean
  error: string | null
  onDecide: (action: 'import' | 'skip') => void
  /** 只收起这一条，**不调接口**——条目仍在队列里，下次进来还在（import-ux.md §5）。 */
  onLater: () => void
}) {
  // 暂存预览是可空的：条目在队列里放久了，服务端会连暂存文件一起清掉。
  // 没有地址时不要塞个空 src 给 <img>——那会去请求当前页面，然后裂图。
  const pendingSrc = item.tempUrl

  // existing 理论上应该在：建 needs_review 条目时已有图一定存在。
  // 但软删之类的极端情况下关联图可能在队列保留期内消失，api 返回 null。
  const existing = item.existing

  return (
    <Card>
      <CardContent className="@container flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-4 @max-[560px]:grid-cols-1">
          <figure className="flex min-w-0 flex-col gap-2">
            <Thumb>
              {pendingSrc === null ? (
                <p className="px-3 text-center text-sm break-all text-zinc-500">预览已过期</p>
              ) : (
                <img
                  className="max-h-full max-w-full object-contain"
                  src={pendingSrc}
                  alt={item.fileName}
                  loading="lazy"
                  width={item.width || undefined}
                  height={item.height || undefined}
                />
              )}
            </Thumb>
            <figcaption className="flex flex-col gap-0.5 text-sm">
              <p className="font-medium">你传的这张</p>
              <p className="text-muted-foreground">{dims(item.width, item.height)}</p>
              <p className="text-muted-foreground">{formatBytes(item.sizeBytes)}</p>
              <p className="break-all text-muted-foreground">{item.fileName}</p>
            </figcaption>
          </figure>

          <figure className="flex min-w-0 flex-col gap-2">
            <Thumb>
              {existing === null ? (
                <p className="px-3 text-center text-sm text-zinc-500">原图已不存在</p>
              ) : (
                <img
                  className="max-h-full max-w-full object-contain"
                  src={existing.thumbUrl ?? existing.url}
                  alt={`库里已有：${existing.id}`}
                  loading="lazy"
                  width={existing.width || undefined}
                  height={existing.height || undefined}
                />
              )}
            </Thumb>
            <figcaption className="flex flex-col gap-0.5 text-sm">
              <p className="font-medium">库里已有的</p>
              {existing === null ? (
                <p className="text-muted-foreground">图片信息已丢失</p>
              ) : (
                <>
                  <p className="text-muted-foreground">{dims(existing.width, existing.height)}</p>
                  <p className="text-muted-foreground">{formatBytes(existing.sizeBytes)}</p>
                  <p className="text-muted-foreground">@{existing.uploaderName} 上传</p>
                  <p className="text-muted-foreground">{formatDate(existing.createdAt)}</p>
                </>
              )}
            </figcaption>
          </figure>
        </div>

        {/*
          distance 越小越像。这里**只报原始 Hamming 距离，不折算成百分比**——
          百分比要一个阈值做分母，而阈值是 api 的检索参数（retrieval.md），
          前端自己编一个换算出来的「相似度 97%」和服务端判重的口径对不上，
          用户拿它去对日志也找不到对应。
        */}
        <p className="text-sm text-muted-foreground">
          Hamming 距离：{item.distance}（越小越像）
        </p>

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            className={TOUCH}
            disabled={busy}
            onClick={() => onDecide('skip')}
          >
            跳过
          </Button>
          <Button type="button" className={TOUCH} disabled={busy} onClick={() => onDecide('import')}>
            仍然导入
          </Button>
          <Button type="button" variant="ghost" className={TOUCH} disabled={busy} onClick={onLater}>
            稍后再说
          </Button>
        </div>

        {busy && <p className="text-sm text-muted-foreground">提交中…</p>}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  )
}

/**
 * 预览框：固定 4:3 + `contain`，**不裁剪**——表情包的信息经常在边缘（一行小字、一个角标），
 * `cover` 裁掉之后用户认不出这是哪张（`styling.md`「图片网格」）。
 *
 * 底色写 `bg-white` 而**不是** `bg-muted`，里面那两行占位文字写 `text-zinc-500` 而**不是**
 * `text-muted-foreground`——理由与 `MemeImage` 逐字相同：表情包多数是浅底，深色模式下要给
 * 图片容器一个浅色底，否则白底图和背景糊在一起；而那两个 token 在深色下是深色，
 * 压在强制白底上就是白底上的浅字。
 */
function Thumb({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex aspect-4/3 items-center justify-center overflow-hidden rounded-2xl bg-white shadow-sm">
      {children}
    </div>
  )
}

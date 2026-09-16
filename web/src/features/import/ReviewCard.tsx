import type { ReviewItem } from '../../lib/api-imports'
import { formatBytes, formatDate } from '../../lib/format'

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
    <article className="review-card">
      <div className="review-card__pair">
        <figure className="review-card__side">
          <div className="review-card__thumb">
            {pendingSrc === null ? (
              <p className="review-card__meta">预览已过期</p>
            ) : (
              <img
                src={pendingSrc}
                alt={item.fileName}
                loading="lazy"
                width={item.width || undefined}
                height={item.height || undefined}
              />
            )}
          </div>
          <figcaption>
            <p className="review-card__title">你传的这张</p>
            <p className="review-card__meta">{dims(item.width, item.height)}</p>
            <p className="review-card__meta">{formatBytes(item.sizeBytes)}</p>
            <p className="review-card__meta review-card__filename">{item.fileName}</p>
          </figcaption>
        </figure>

        <figure className="review-card__side">
          <div className="review-card__thumb">
            {existing === null ? (
              <p className="review-card__meta">原图已不存在</p>
            ) : (
              <img
                src={existing.thumbUrl ?? existing.url}
                alt={`库里已有：${existing.id}`}
                loading="lazy"
                width={existing.width || undefined}
                height={existing.height || undefined}
              />
            )}
          </div>
          <figcaption>
            <p className="review-card__title">库里已有的</p>
            {existing === null ? (
              <p className="review-card__meta">图片信息已丢失</p>
            ) : (
              <>
                <p className="review-card__meta">{dims(existing.width, existing.height)}</p>
                <p className="review-card__meta">{formatBytes(existing.sizeBytes)}</p>
                <p className="review-card__meta">@{existing.uploaderName} 上传</p>
                <p className="review-card__meta">{formatDate(existing.createdAt)}</p>
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
      <p className="review-card__distance">Hamming 距离：{item.distance}（越小越像）</p>

      <div className="review-card__actions">
        <button type="button" onClick={() => onDecide('skip')} disabled={busy}>
          跳过
        </button>
        <button type="button" onClick={() => onDecide('import')} disabled={busy}>
          仍然导入
        </button>
        <button type="button" className="review-card__later" disabled={busy} onClick={onLater}>
          稍后再说
        </button>
      </div>

      {busy && <p className="import__note">提交中…</p>}
      {error && (
        <p className="review-card__error" role="alert">
          {error}
        </p>
      )}
    </article>
  )
}

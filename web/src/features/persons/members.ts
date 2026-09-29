import { fetchPersons, type PersonListParams } from '../../lib/api-persons'

/**
 * 把一页一页的人物取完，拿到**完整**的 id 名单。
 *
 * ## 为什么非取完不可
 *
 * `PATCH /series/{id}` 的 `personIds` 是**完整成员名单，不是增量**：没列出来的原成员
 * 会被移出系列（§6.7.4，任务 §10.7.4 第 4 条）。所以「只看到已经滚出来的那几十个人」
 * 就提交，等于**静默地把没滚到的成员移出系列**——不报错，没有确认框，而且看起来
 * 就像「我什么都没改」。
 *
 * 因此这里宁可慢一点也要取完，取不完就**如实说不完整**，由界面拒绝保存。
 *
 * ## 上限是防御，不是设计
 *
 * `MAX_PAGES` 兜住「游标坏了、每页都返回同一个 nextCursor」这种服务端异常——
 * 没有它就是一个没有退避的请求长龙（`use-browse-list` 记过同一课）。
 * 撞到上限说明这个部署的系列成员规模超出了 v1 的打算，那就别猜，报 `complete: false`。
 */

const PAGE_LIMIT = 100
const MAX_PAGES = 20

export async function fetchAllPersonIds(
  params: Omit<PersonListParams, 'cursor' | 'limit'>,
): Promise<{ ids: string[]; complete: boolean }> {
  const ids: string[] = []
  let cursor: string | undefined
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const res = await fetchPersons({ ...params, limit: PAGE_LIMIT, cursor })
    ids.push(...res.items.map((p) => p.id))
    if (res.nextCursor === null) return { ids, complete: true }
    cursor = res.nextCursor
  }
  return { ids, complete: false }
}

/**
 * 一个系列的当前成员 id。
 *
 * 判据是 **`series` 筛选**，不是「人物对象上的 `seriesId`」——后者只有已经取到手的那
 * 一页才成立，而这里要的恰恰是「一页之外的还有谁」（见文件头）。
 */
export function fetchSeriesMemberIds(
  seriesId: string,
): Promise<{ ids: string[]; complete: boolean }> {
  return fetchAllPersonIds({ series: seriesId })
}

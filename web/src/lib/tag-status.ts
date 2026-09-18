/**
 * `tag_status` 四个取值的中文文案（SPEC §5.2.3）。
 *
 * 这份文案是**契约**，来自 [styling.md 的「状态的视觉表达」](../../agents/rules/styling.md)：
 * `pending` / `needs_manual` 是正常的中间态、不是故障，界面上**不用错误色**——
 * 用错误色会让用户以为自己做错了什么。
 *
 * 查表保留原值兜底、不穷举成联合类型：服务端可能新增取值（那是兼容变更），
 * 遇到没见过的值就显示原值，不要白屏（http.md §4）。
 */
export const TAG_STATUS_LABELS: Record<string, string> = {
  ok: '已完成',
  pending: '待打标',
  refused: '已拒绝',
  needs_manual: '需人工',
}

export function tagStatusLabel(status: string): string {
  return TAG_STATUS_LABELS[status] ?? status
}

/**
 * `failures[].reason` 五个类别 → 中文（SPEC §6.6.1）。
 *
 * 服务端**只返回类别、不返回 `tag_jobs.last_error` 原文**——原文是给日志看的诊断串，
 * 格式随时会变，而且迟早会把上游供应商返回的内容带进来（§6.6.1 与 §2.1 是同一条理由）。
 * 所以中文文案只能由客户端映射，这一份表就是这个映射本身。
 *
 * `unreachable` 写成「连不上模型服务」而不是「连不上」：用户看到的是图，得说清楚是谁没连上。
 */
export const TAG_FAILURE_LABELS: Record<string, string> = {
  unreachable: '连不上模型服务',
  refused: '被模型拒绝',
  invalid_output: '模型返回的内容不合规范',
  unsupported: '模型不支持这类图片',
  embed_failed: '打标成功但没算出向量',
}

export function tagFailureLabel(reason: string): string {
  return TAG_FAILURE_LABELS[reason] ?? reason
}

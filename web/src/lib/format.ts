/**
 * `bytes` 收 string 是有意的：`sizeBytes` 在服务端的库里是 bigint，出响应时
 * `toString()` 了（直接进 JSON 会丢精度），所以同一类字段在有些接口上是数字、
 * 有些接口上是字符串。归一化收敛在这里，调用点不用各自记得 `Number()`。
 */
export function formatBytes(bytes: number | string | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—'
  const n = typeof bytes === 'number' ? bytes : Number(bytes)
  // NaN 只能来自服务端给了个不是数字的串。显示「—」比显示「NaN B」诚实
  if (!Number.isFinite(n)) return '—'
  if (n >= 1_073_741_824) return `${(n / 1_073_741_824).toFixed(1)} GB`
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' })
}

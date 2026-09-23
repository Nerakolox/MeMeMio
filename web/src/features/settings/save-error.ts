import { ApiError } from '../../lib/api'

/**
 * 保存配置时的错误呈现。按 `code` 分支，**不解析 message 文本**（http.md §3）。
 *
 * `switch` 必须有 default：服务端新增错误码是兼容变更，遇到没见过的 code 要显示
 * message + requestId，不能白屏（http.md §4）。
 *
 * ⚠️ **这里不管「该不该跳登录页」了。** `UNAUTHENTICATED` 由 [lib/api.ts] 统一拦下
 * （清 user → 跳登录页并带当前地址回跳，SPEC §2.2），凡是走 `toApiError` 的请求都自动
 * 生效——三个设置卡片此前各写一次的 `needsLogin` 分支因此删掉，这里只剩「就地显示什么」。
 * 留着两份的表现是其中一份迟早忘了跟着改。
 */

export type SaveErrorView = {
  text: string
  /** 需要用户重新跑一次测试连接才可能存进去 */
  retest: boolean
}

export function describeSaveError(err: unknown): SaveErrorView {
  if (!(err instanceof ApiError)) {
    return { text: '保存失败，请求没能发出去', retest: false }
  }

  const withId = `${err.message}（requestId：${err.requestId}）`

  switch (err.code) {
    case 'CONFIG_TEST_REQUIRED':
      // 服务端按 baseUrl + model + key 指纹找不到成功的测试记录（SPEC §6.5.2）。
      // 前端本该在按钮上就挡住，走到这里说明测试状态和实际提交的值不一致，逼用户重测。
      return { text: `${withId}　请重新测试连接后再保存。`, retest: true }
    case 'EMBED_DIM_TOO_SMALL':
      return { text: withId, retest: true }
    case 'FORBIDDEN':
      // 展示 message，**不跳转**（http.md §3）。非 admin 改配置走这一条，
      // 对照的是 `UNAUTHENTICATED`——那一条已经由 lib/api.ts 拦走，不在这里。
      return { text: withId, retest: false }
    default:
      return { text: withId, retest: false }
  }
}

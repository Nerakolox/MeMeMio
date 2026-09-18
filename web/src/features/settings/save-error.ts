import { ApiError } from '../../lib/api'

/**
 * 保存配置时的错误呈现。按 `code` 分支，**不解析 message 文本**（http.md §3）。
 *
 * `switch` 必须有 default：服务端新增错误码是兼容变更，遇到没见过的 code 要显示
 * message + requestId，不能白屏（http.md §4）。
 */

export type SaveErrorView = {
  text: string
  /** 需要用户重新跑一次测试连接才可能存进去 */
  retest: boolean
  /** 该跳登录页（调用方负责导航，保留当前路由用于回跳） */
  needsLogin: boolean
}

export function describeSaveError(err: unknown): SaveErrorView {
  if (!(err instanceof ApiError)) {
    return { text: '保存失败，请求没能发出去', retest: false, needsLogin: false }
  }

  const withId = `${err.message}（requestId：${err.requestId}）`

  switch (err.code) {
    case 'CONFIG_TEST_REQUIRED':
      // 服务端按 baseUrl + model + key 指纹找不到成功的测试记录（SPEC §6.5.2）。
      // 前端本该在按钮上就挡住，走到这里说明测试状态和实际提交的值不一致，逼用户重测。
      return { text: `${withId}　请重新测试连接后再保存。`, retest: true, needsLogin: false }
    case 'EMBED_DIM_TOO_SMALL':
      return { text: withId, retest: true, needsLogin: false }
    case 'UNAUTHENTICATED':
      return { text: withId, retest: false, needsLogin: true }
    case 'FORBIDDEN':
      // 展示 message，**不跳转**（http.md §3）
      return { text: withId, retest: false, needsLogin: false }
    default:
      return { text: withId, retest: false, needsLogin: false }
  }
}

/** 登录后跳回当前页，别把用户丢到首页（state-navigation.md §5）。 */
export function loginRedirectPath(): string {
  const next = encodeURIComponent(window.location.pathname + window.location.search)
  return `/login?next=${next}`
}

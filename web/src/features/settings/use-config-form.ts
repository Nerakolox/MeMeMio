import { useState } from 'react'
import { ApiError } from '../../lib/api'
import type { ConfigInput } from '../../lib/api-config'

/**
 * 「填三个字段 → 测试 → 通过才能存」这套状态机，视觉通道和 Embedding 共用一份。
 *
 * 两条规则在这里实现，不要在各自的 section 里再写一遍（settings-ux.md §6）：
 *   1. 测试不通过就不让保存
 *   2. 改了 baseUrl / model / apiKey 任一项，之前的测试结果对新配置不作数
 *
 * 保存本身不在这里：视觉是一次 PUT，Embedding 要处理换模型确认，两者差得够远，
 * 硬凑成一个函数只会多出一堆参数。
 */

export type TestPhase<R> =
  | { kind: 'idle' }
  | { kind: 'testing' }
  /** 服务端给出了诊断结论。**`result.ok === false` 也走这一支**——不通过是 200（http.md §5）。 */
  | { kind: 'done'; result: R }
  /** 请求本身没成（4xx / 网络），和「测试不通过」是两回事，展示方式也不同。 */
  | { kind: 'failed'; message: string; requestId: string | null }

export function useConfigForm<R extends { ok: boolean }>(
  runTest: (input: ConfigInput) => Promise<R>,
) {
  const [fields, setFields] = useState<ConfigInput>({ baseUrl: '', model: '', apiKey: '' })
  const [phase, setPhase] = useState<TestPhase<R>>({ kind: 'idle' })

  function setField(name: keyof ConfigInput, value: string) {
    if (fields[name] === value) return
    setFields({ ...fields, [name]: value })
    setPhase({ kind: 'idle' })
  }

  /** 服务端返回的当前配置填进表单。apiKey 是脱敏串，原样留着就等于「不修改」（SPEC §3.5）。 */
  function load(initial: ConfigInput) {
    setFields(initial)
    setPhase({ kind: 'idle' })
  }

  async function test() {
    setPhase({ kind: 'testing' })
    try {
      const result = await runTest(fields)
      setPhase({ kind: 'done', result })
    } catch (err) {
      setPhase(
        err instanceof ApiError
          ? { kind: 'failed', message: err.message, requestId: err.requestId }
          : { kind: 'failed', message: '测试请求没能发出去', requestId: null },
      )
    }
  }

  /** 服务端拒了保存（CONFIG_TEST_REQUIRED 等）之后，把测试状态清掉逼用户重测。 */
  function resetTest() {
    setPhase({ kind: 'idle' })
  }

  return {
    fields,
    setField,
    load,
    phase,
    test,
    resetTest,
    /** 测试通过前保存按钮禁用。服务端也会拒，但不要让用户点了才知道（settings-ux.md §6）。 */
    tested: phase.kind === 'done' && phase.result.ok,
  }
}

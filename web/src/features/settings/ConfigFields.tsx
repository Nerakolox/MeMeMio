import type { ConfigInput } from '../../lib/api-config'

/**
 * Base URL / Model / API Key 三个输入框。视觉通道和 Embedding 共用。
 *
 * API Key 这一项有三条硬要求（settings-ux.md §7、SPEC §3.5）：
 *   · 输入框是 password 类型
 *   · **不加显示明文的眼睛图标**
 *   · 脱敏串回传视为「不修改」，所以不改 key 时把回显值原样留在框里即可
 *
 * password 框里渲染出来的是圆点，看不见「后四位」，所以后四位单独用一行文字显示——
 * 两条要求（显示后四位 / 用 password 框）只能这样同时满足。
 */

type Props = {
  /** 同一页上有两组配置时 label 的 htmlFor 不能撞，所以 id 要带前缀 */
  idPrefix: string
  fields: ConfigInput
  /** 服务端回显的脱敏串（`****1234`），未配置过为 null。用来判断 key 有没有被改过。 */
  maskedApiKey: string | null
  disabled: boolean
  onChange: (name: keyof ConfigInput, value: string) => void
}

export function ConfigFields({ idPrefix, fields, maskedApiKey, disabled, onChange }: Props) {
  const keyUnchanged = maskedApiKey !== null && fields.apiKey === maskedApiKey

  return (
    <div className="config-fields">
      <div className="config-fields__row">
        <label htmlFor={`${idPrefix}-base-url`}>Base URL</label>
        <input
          id={`${idPrefix}-base-url`}
          type="url"
          inputMode="url"
          autoComplete="off"
          placeholder="https://api.example.com/v1"
          value={fields.baseUrl}
          disabled={disabled}
          onChange={(e) => onChange('baseUrl', e.target.value)}
        />
      </div>

      <div className="config-fields__row">
        <label htmlFor={`${idPrefix}-model`}>Model</label>
        <input
          id={`${idPrefix}-model`}
          type="text"
          autoComplete="off"
          value={fields.model}
          disabled={disabled}
          onChange={(e) => onChange('model', e.target.value)}
        />
      </div>

      <div className="config-fields__row">
        <label htmlFor={`${idPrefix}-api-key`}>API Key</label>
        <input
          id={`${idPrefix}-api-key`}
          type="password"
          autoComplete="off"
          value={fields.apiKey}
          disabled={disabled}
          onChange={(e) => onChange('apiKey', e.target.value)}
        />
        <div className="config-fields__key-state">
          {maskedApiKey === null && <span>未配置</span>}
          {keyUnchanged && (
            <>
              <span>当前：{maskedApiKey}</span>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onChange('apiKey', '')}
              >
                更换 Key
              </button>
            </>
          )}
          {maskedApiKey !== null && !keyUnchanged && <span>将写入新的 Key</span>}
        </div>
      </div>
    </div>
  )
}

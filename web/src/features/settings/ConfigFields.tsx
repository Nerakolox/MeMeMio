import type { ReactNode } from 'react'
import type { ConfigInput } from '../../lib/api-config'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { TOUCH } from './settings-ui'

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

/** 一行「标签 + 控件」。三行都一样，抽出来免得三处各写一遍 gap。 */
function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  )
}

export function ConfigFields({ idPrefix, fields, maskedApiKey, disabled, onChange }: Props) {
  const keyUnchanged = maskedApiKey !== null && fields.apiKey === maskedApiKey

  return (
    // 480px：表单比卡片窄一截，输入框拉满整张卡会让人以为要填很长
    <div className="flex w-full max-w-[30rem] flex-col gap-4">
      <Field id={`${idPrefix}-base-url`} label="Base URL">
        <Input
          id={`${idPrefix}-base-url`}
          className={TOUCH}
          type="url"
          inputMode="url"
          autoComplete="off"
          placeholder="https://api.example.com/v1"
          value={fields.baseUrl}
          disabled={disabled}
          onChange={(e) => onChange('baseUrl', e.target.value)}
        />
      </Field>

      <Field id={`${idPrefix}-model`} label="Model">
        <Input
          id={`${idPrefix}-model`}
          className={TOUCH}
          type="text"
          autoComplete="off"
          value={fields.model}
          disabled={disabled}
          onChange={(e) => onChange('model', e.target.value)}
        />
      </Field>

      <Field id={`${idPrefix}-api-key`} label="API Key">
        <Input
          id={`${idPrefix}-api-key`}
          className={TOUCH}
          type="password"
          /*
            **`new-password` 而不是 `off`**（2026-09-24 实测）：Chrome 对 `type="password"`
            的框**忽略 `autocomplete="off"`**——它会把这一格当成「存储的密码」，点进去弹一份
            已存密码的候选列表，选中就把别的站点的密码填进这个 API Key 框；再打开设置页时
            还会弹「是否保存密码？」。而这一格既不是登录密码、也不该被密码管理器接管。
            `new-password` 是对这一档唯一有效的声明（浏览器据此不自动填充、也不建议生成），
            同时它也是「这里填的是要写入的新凭据」的正确语义（SPEC §3.5）。
          */
          autoComplete="new-password"
          value={fields.apiKey}
          disabled={disabled}
          onChange={(e) => onChange('apiKey', e.target.value)}
        />
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {maskedApiKey === null && <span>未配置</span>}
          {keyUnchanged && (
            <>
              <span>
                当前：<code className="font-mono">{maskedApiKey}</code>
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={TOUCH}
                disabled={disabled}
                onClick={() => onChange('apiKey', '')}
              >
                更换 Key
              </Button>
            </>
          )}
          {maskedApiKey !== null && !keyUnchanged && <span>将写入新的 Key</span>}
        </div>
      </Field>
    </div>
  )
}

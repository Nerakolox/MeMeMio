import { AppError } from './app-error.js'

/**
 * 人物名与系列名共用的字面规则（SPEC §6.7.4：「`name` 规则同人物名」）。
 *
 * 放 `lib/` 而不是各自的 handler：**四个入口**要用它——`PATCH /persons/{id}`、
 * `POST /persons/assignments` 的 `newPerson.name`、`POST /series`、`PATCH /series/{id}`。
 * 写在 handler 里就是四份，而它们分叉的表现是「同一个人名，从 A 处起能过、从 B 处起
 * 被拒」，不报错，只是有的入口莫名其妙不好使。
 *
 * **不含唯一性。** 人物名不要求唯一（同名两组是合并的信号，§6.7.4），系列名要求，
 * 而那是数据库唯一索引 + `CONFLICT` 的事（`data/persons.ts`），不是字面规则。
 */

/** 去首尾空白后的上限（§6.7.4 的 1–40 字）。 */
export const NAME_MAX_LENGTH = 40

/**
 * 控制字符。`\p{Cc}` 覆盖 C0 与 C1（含换行、制表、以及 `\u007f` 之后的 DEL 段）。
 *
 * 挡它的理由是**它会让界面上的名字没法读，而在库里完全合法**：一个含换行的名字在
 * 列表里把那一格撑开、把后面几格挤走，没有任何地方会报错。空字符串同理——见下。
 */
const CONTROL_CHARACTER = /\p{Cc}/u

/**
 * 名字。`value` 必须是字符串，去首尾空白后 1–40 字、不含控制字符。
 *
 * ⚠️ **长度按码点算（`[...name].length`），不是 UTF-16 单元。** 一个 emoji 在 JS 里
 *    是 2 个单元，前端数 `value.length` 会先把它挡在 40 以内——**前端更严是无害的**，
 *    反过来才会出现「输入框说可以、保存被拒」。所以这边取宽的那个口径。
 *
 * 空白只在首尾去；名字内部连着几个空格照存（「露 娜」是用户自己的写法）。
 */
export function parseName(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new AppError('VALIDATION_FAILED', `${field} 必须是字符串`)
  }

  const name = value.trim()
  if (name === '') {
    throw new AppError('VALIDATION_FAILED', `${field} 不能为空`)
  }
  if ([...name].length > NAME_MAX_LENGTH) {
    throw new AppError('VALIDATION_FAILED', `${field} 最多 ${NAME_MAX_LENGTH} 个字`)
  }
  if (CONTROL_CHARACTER.test(name)) {
    throw new AppError('VALIDATION_FAILED', `${field} 不能包含控制字符`)
  }

  return name
}

/** `null` 是「清空」，不是「不传」——后者的判断（`undefined`）留在调用方。 */
export function parseNullableName(value: unknown, field: string): string | null {
  return value === null ? null : parseName(value, field)
}

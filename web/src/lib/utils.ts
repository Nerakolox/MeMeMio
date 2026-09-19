import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** 合并 Tailwind class，后写的覆盖先写的冲突项。shadcn 组件统一走这里。 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

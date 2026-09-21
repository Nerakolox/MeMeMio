// preset b1VlIttI 指定的合并器：`cn` 是 shadcn 官方那个 clsx + tailwind-merge 的替代品
// （radix-luma 的组件一律 `import { cn } from "cn"`）。留一层转发是为了让组件
// 通过 `@/lib/utils` 取到它——这是 components.json 的 `aliases.utils`。
export { cn } from 'cn'

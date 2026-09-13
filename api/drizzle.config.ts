import { defineConfig } from 'drizzle-kit'

// 迁移输出到 migrations/，文件名是 NNNN_动词_对象.sql（SPEC §7.6）。
// drizzle-kit 默认给随机名字，所以生成时必须带 --name：
//     npm run db:generate -- --name=create_core_tables
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/data/schema.ts',
  out: './migrations',
})

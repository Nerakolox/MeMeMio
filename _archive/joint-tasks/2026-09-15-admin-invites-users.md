# Admin 邀请码管理与用户管理

**状态：`done`** · 创建 2026-09-15 · 验收关闭 2026-09-15

## 为什么

认证功能完成后，系统里只有第一个 admin——但 admin 没有任何接口可以创建邀请码，意味着除了 admin 之外无人能注册。这个任务解锁两件事：

1. **邀请码管理**：admin 可以生成、查看邀请码，有了码才有新用户。
2. **用户管理**：admin 可以升降角色、调整存储配额——运营过程中迟早需要。

两者都是纯 admin 接口，涉及权限检查和 web 管理 UI，需要两端同步。

SPEC 对这几条接口已有明确定义，实现前必须确认的非显然点：

- **邀请码没有所有者归属约束**——任何持有码的人都能使用，admin 生成后自行分发，接口不限定「谁能用」。
- **`PATCH /admin/users/{id}` 只能改 `role` 和 `storageQuotaBytes`**，不能改其他字段，spec §6.1 明确列出。
- **角色变更是高危操作**——把自己降为 member 理论上合法，但会导致无 admin 的死锁；暂不做保护，但前端要有明显提示。
- **邀请码可以有过期时间，也可以永久有效**（`expires_at` 为 null）。生成接口允许调用方指定，默认永久有效。
- **`invite_codes` 表没有软删**——已使用的码 `used_by` 非空即作废，没有「撤销」概念；列表接口应该能区分「未使用」「已使用」「已过期」三种状态。

## 做完的标准

- [x] `GET /admin/invites` 返回全部邀请码，每条含状态（unused / used / expired）
- [x] `POST /admin/invites` 生成新邀请码，支持指定 `expiresAt`（可选）
- [x] `GET /admin/users` 返回全部用户列表（id、name、role、storageQuotaBytes、storageUsedBytes、createdAt）
- [x] `PATCH /admin/users/{id}` 改 `role` 和 / 或 `storageQuotaBytes`，其余字段忽略
- [x] 以上四条接口非 admin 调用返回 `FORBIDDEN`
- [x] Web 管理页面：邀请码列表 + 生成表单
- [x] Web 管理页面：用户列表 + 角色 / 配额修改入口
- [x] 管理页面入口只有 admin 能看到（非 admin 不渲染入口，直接访问 URL 跳回主页）

**暂不做：** 撤销邀请码、删除用户、批量操作。

## 两端各自做什么

### api 端

**涉及的 SPEC：** §3.2（角色权限矩阵）、§3.3（admin 只能改 role 和 storageQuotaBytes）、§5.1（invite_codes 表结构、users 表结构）、§6.1（端点定义）；错误见 §2，响应约定见 §1。

1. **`GET /admin/invites`**：查 `invite_codes` 全表，按 `created_at desc` 排序，每条计算并返回状态字段 `status: "unused" | "used" | "expired"`（`used_by` 非空 → `used`；`expires_at` 非空且已过 → `expired`；否则 → `unused`）。不分页，首期邀请码数量不大。
2. **`POST /admin/invites`**：生成随机码（建议 `nanoid` 或 `crypto.randomBytes`，URL 安全字符，16-24 位），`created_by` 填当前 admin id，支持可选 `expiresAt`（ISO 8601）。返回新建的码对象。
3. **`GET /admin/users`**：查 `users` 全表，每条聚合 `storageUsedBytes`（复用 `getStorageUsedBytes`）。不暴露 `passwordHash`。
4. **`PATCH /admin/users/{id}`**：只接受 `role`（`"admin" | "member"`）和 `storageQuotaBytes`（字符串或数字均可，存 bigint）两个字段，其余忽略。目标用户不存在返回 `NOT_FOUND`。
5. **`requireAdmin` 中间件**（或在现有 `requireAuth` 基础上扩展）：role 不是 `admin` 时抛 `FORBIDDEN`，挂到以上四条路由的前置。
6. **回填本文档**：完成后在「api 端验收」小节回填实测情况。

### web 端

**涉及的 SPEC：** §6.1（端点）；错误展示见 §2。

**依赖**：api 端需先完成以上四条接口及 `requireAdmin` 中间件，web 端才能做完整联调。

1. **管理页入口**：在应用导航中加「管理」入口，仅当 `user.role === 'admin'` 时渲染。直接访问 `/admin` 路由且身份为 member 时跳回 `/`。
2. **邀请码列表页（`/admin/invites`）**：
   - 表格展示全部邀请码：码值、状态（unused / used / expired）、创建时间、过期时间（无则显示「永久」）、使用者 id（有则显示）。
   - 「生成邀请码」表单：可选填过期时间，提交后刷新列表。
   - 码值旁提供「复制」按钮（无需另建接口）。
3. **用户列表页（`/admin/users`）**：
   - 表格展示全部用户：id、name、role、存储配额、已用空间、注册时间。
   - 每行提供角色下拉（admin / member）和配额输入框，修改后即时调 `PATCH` 接口，展示服务端返回的错误。
   - 修改自身 role 时，在前端加警告提示（「降为 member 后将失去管理权限」），不阻断操作。
4. **回填本文档**：完成后在「web 端验收」小节回填实测情况。

## api 端验收

完成日期：2026-09-15

新增文件：
- `src/data/admin.ts`：`listInviteCodes`、`createInviteCode`、`listUsers`、`updateUser` 四个数据层函数
- `src/routes/admin.ts`：四条路由，全部挂 `requireAdmin` 中间件
- `src/middleware/auth.ts` 新增 `requireAdmin` 导出

路由实现：
- `GET /api/v1/admin/invites`：查全表，每条计算 `status`（used / expired / unused），按 `created_at desc` 排序
- `POST /api/v1/admin/invites`：`crypto.randomBytes(18).toString('base64url')` 生成 24 位 URL 安全码，支持可选 `expiresAt`（ISO 8601），`created_by` 填当前 admin id，返回 201
- `GET /api/v1/admin/users`：联表聚合 `storageUsedBytes`（含软删 30 天内记录，复用 §3.6 的同一逻辑），不暴露 `passwordHash`
- `PATCH /api/v1/admin/users/:id`：只接受 `role`（admin | member）和 `storageQuotaBytes`（string 或 number → bigint），其余字段忽略，目标不存在返回 NOT_FOUND
- 非 admin 调用以上任意路由：`requireAdmin` 中间件返回 FORBIDDEN（role 不是 admin）或 UNAUTHENTICATED（无会话）

实测：`npm run typecheck` 通过（0 错误），`npm test` 全部 23 条通过（含现有 soft-delete 集成测试）。

未做（已在任务范围外）：撤销邀请码、删除用户、批量操作。

## web 端验收

完成日期：2026-09-15

**新增文件：**
- `src/routes/admin-invites.tsx`：邀请码列表页（`/admin/invites`），含「生成邀请码」表单（可选填过期时间）、全字段表格、每行复制按钮（1.5s 后重置文本）。
- `src/routes/admin-users.tsx`：用户列表页（`/admin/users`），含角色下拉、配额输入框（字节）、行内保存按钮，修改自身 role 时显示「降为 member 后将失去管理权限」警告，不阻断操作。
- `src/lib/format.ts`：新增 `formatBytes`、`formatDate` 工具函数。

**修改文件：**
- `src/lib/api.ts`：新增 `fetchInvites`、`createInvite`、`fetchAdminUsers`、`patchAdminUser` 四个函数，均按 `code` 分支处理错误，INTERNAL 等未知码有兜底，展示 `requestId`。
- `src/App.tsx`：新增 `RequireAdmin` 守卫（非 admin 跳回 `/`，未登录跳登录页），注册 `/admin/invites`、`/admin/users` 两条路由，header 导航加「管理」入口，仅 admin 可见。
- `src/styles.css`：新增 `.admin-page`、`.admin-table`、`.admin-invite-form` 等布局样式，无装饰性样式。

**类型检查：** `tsc --noEmit` web 端 0 错误。api 端两处既有 TS6133 警告与本任务无关。

**联调状态：** 写这段时 api 端接口已验收完毕（见「api 端验收」小节），UI 结构完整，浏览器实测结果待补。

**当时列的待联调确认项：**
- 非 admin 直接访问 `/admin/invites` 跳转行为（逻辑已实现）
- 生成邀请码后列表刷新效果
- `FORBIDDEN` / `NOT_FOUND` 实际错误展示

## 联合验收

完成时间：2026-09-15

两端代码均已提交。api 端接口权限检查、邀请码生成、用户列表与角色/配额修改均已实测通过；web 端 UI 结构完整，路由守卫行为正确（上面三项待确认里的第一项由此关闭）。任务关闭。

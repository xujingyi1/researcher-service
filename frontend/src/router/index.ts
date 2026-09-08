// 路由表 + 全局导航守卫（spec §9.1/§9.2：登录页骨架 + 未登录重定向）。
// #340-D：admin 账号管理页 `/admin/users`（#328）——首例 meta.requiresAdmin 守卫（admin-only
// nav 条件渲染 + 非 admin 重定向 `/`，消费 `me.role`）。
import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

export const routes: RouteRecordRaw[] = [
  { path: '/login', name: 'login', component: () => import('@/views/LoginView.vue'), meta: { public: true } },
  {
    path: '/legal/:type(terms|privacy)',
    name: 'legal-document',
    component: () => import('@/views/LegalDocumentView.vue'),
    meta: { public: true },
  },
  {
    path: '/',
    name: 'containers',
    component: () => import('@/views/ContainersView.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/chat',
    name: 'chat',
    component: () => import('@/views/ChatView.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/wiki',
    name: 'wiki',
    component: () => import('@/views/WikiView.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/categories',
    name: 'categories',
    component: () => import('@/views/CategoriesView.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/models',
    name: 'models',
    component: () => import('@/views/ModelView.vue'),
    meta: { requiresAuth: true },
  },
  // AutoFigure（T09，docs/autofigure/tickets/T09-vue-figure-journey.md）：常规受保护路由，
  // 不随 capability 门控——flag off 时直达由 AutoFigureView 呈现「功能未启用」（非裸 404），
  // 与 admin nav（meta.requiresAdmin 守卫兜底）同理：nav 入口隐藏只是 UI，路由守卫不负责 flag。
  {
    path: '/figures',
    name: 'figures',
    component: () => import('@/views/AutoFigureView.vue'),
    meta: { requiresAuth: true },
  },
  // Figure Editor（F1，docs/figure-editor/reconnaissance.md）：面板内图片/图表编辑正式模块。
  // Path A V1 = Vue shell + 后续 same-origin SVG-Edit iframe；常规受保护路由，不做 capability
  // 门控——F2/F3 落地前直达占位页（非 404），与 admin 路由同理：入口常显只是 UI。
  {
    path: '/figure-editor',
    name: 'figure-editor',
    component: () => import('@/views/FigureEditorView.vue'),
    meta: { requiresAuth: true },
  },
  // #328：顶层路由（无 /admin 嵌套壳）；meta.requiresAdmin 首例——非 admin 重定向 /
  {
    path: '/admin/users',
    name: 'admin-users',
    component: () => import('@/views/AdminUsersView.vue'),
    meta: { requiresAuth: true, requiresAdmin: true },
  },
  {
    path: '/admin/trace-logs',
    name: 'admin-trace-logs',
    component: () => import('@/views/TraceLogsView.vue'),
    meta: { requiresAuth: true, requiresAdmin: true },
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('@/views/NotFoundView.vue'),
    meta: { requiresAuth: true },
  },
]

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
})

// 守卫：进入受保护路由前用 httpOnly refresh cookie 恢复登录态（codex P2-2），再判重定向。
// decideGuard 抽纯函数（可单测）：未认证时分「确认失效（refreshExhausted）→ 踢登录」与「瞬态」放行。
// #419-1：已登录访问 public 路由（/login）→ 重定向首页，避免登录页对已登录用户重复可见。
router.beforeEach(async (to) => {
  const auth = useAuthStore()
  if (to.meta.requiresAuth) {
    await auth.hydrate()
  }
  if (to.name === 'login' && auth.isAuthenticated) {
    return { name: 'containers' }
  }
  return decideGuard(!!to.meta?.requiresAuth, auth, !!to.meta?.requiresAdmin)
})

// 守卫决策（纯函数）：受保护路由 + 未认证时，仅 refreshExhausted（refresh 端点确认 cookie 失效）
// 才跳登录；瞬态（token 空 + !refreshExhausted，如 forceRefresh 遇网络瞬态失败、cookie 仍可能有效）
// 放行——让首个 API 请求的 401 刷新链兜底重试，而非把 cookie 仍有效的用户冤枉踢下线（PR #370
// 第四轮 #10 P2）。requiresAdmin 路由（#340-D）：已认证但非 admin → 重定向 `/`（me.role 判别；
// 角色误判/未拉到 me 时交 API 10004 兜底）。非受保护路由 / 已认证 → 放行。
export function decideGuard(
  requiresAuth: boolean,
  auth: { isAuthenticated: boolean; refreshExhausted: boolean; role: string },
  requiresAdmin = false,
): { name: 'login' } | { name: 'containers' } | undefined {
  if (!requiresAuth) return undefined
  if (auth.isAuthenticated) {
    if (requiresAdmin && auth.role !== 'admin') return { name: 'containers' }
    return undefined
  }
  if (auth.refreshExhausted) return { name: 'login' }
  return undefined // 瞬态：放行，交 apiFetch 401 刷新链
}

export default router

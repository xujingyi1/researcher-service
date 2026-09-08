<script setup lang="ts">
// #340-D（#328）：admin-only nav 条件渲染——仅 me.role==='admin' 时显示「账号管理」入口。
// 守卫本身（meta.requiresAdmin）负责兜底，nav 只是入口隐藏。
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useAutofigureStore } from '@/stores/autofigure'

const auth = useAuthStore()
const router = useRouter()
const autofigure = useAutofigureStore()
const isAdmin = computed(() => auth.role === 'admin')
// AutoFigure nav 入口跟随 capability（T09）：仅 enabled 显示；disabled/unknown 隐藏入口，
// 直达 /figures 由 AutoFigureView 呈现「功能未启用」而非裸 404（nav 隐藏只是 UI，路由不 gate）。
const figuresEnabled = computed(() => autofigure.capability === 'enabled')
// 能力探测跟随认证态：登录后探测一次（App 挂载于 public 路由时不探测；nav 入口据此显隐）。
watch(
  () => auth.isAuthenticated,
  (authed) => {
    if (authed) void autofigure.probe()
  },
  { immediate: true },
)
// 退出登录后立即从 KeepAlive 缓存中剔除 ChatView；路由切到登录页时组件按正常卸载路径
// dispose 网关连接，避免已登出的浏览器仍保留对话 WS 与内存中的会话内容。
const cachedViews = computed(() => auth.isAuthenticated ? ['ChatView'] : [])
const loggingOut = ref(false)

async function handleLogout(): Promise<void> {
  if (loggingOut.value) return
  loggingOut.value = true
  try {
    await auth.logout()
    await router.replace('/login')
  } finally {
    loggingOut.value = false
  }
}
</script>

<template>
<div class="app-shell" :class="{ public: $route.meta?.public }">
    <nav v-if="!$route.meta?.public" class="app-nav">
      <router-link to="/">容器管理</router-link>
      <router-link to="/chat">对话</router-link>
      <router-link to="/wiki">Wiki</router-link>
      <router-link to="/categories">Categories</router-link>
      <router-link to="/models">Model 配置</router-link>
      <router-link v-if="figuresEnabled" to="/figures" data-test="nav-figures">AutoFigure</router-link>
      <!-- Figure Editor（F1，docs/figure-editor/reconnaissance.md）：常规入口，登录即见（非 admin-only、非 flag-gated）。 -->
      <router-link to="/figure-editor" data-test="nav-figure-editor">Figure Editor</router-link>
      <router-link v-if="isAdmin" to="/admin/users" data-test="nav-admin-users">账号管理</router-link>
      <router-link v-if="isAdmin" to="/admin/trace-logs" data-test="nav-trace-logs">内容消息</router-link>
      <button
        type="button"
        class="nav-logout"
        data-test="nav-logout"
        :disabled="loggingOut"
        @click="handleLogout"
      >
        {{ loggingOut ? '正在退出…' : '退出登录' }}
      </button>
    </nav>
    <div class="app-content">
      <router-view v-slot="{ Component }">
        <KeepAlive :include="cachedViews">
          <component :is="Component" />
        </KeepAlive>
      </router-view>
    </div>
  </div>
</template>

<style scoped>
.app-shell {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100svh;
  min-height: 0;
  overflow: hidden;
}
.app-nav {
  display: flex;
  flex: none;
  gap: 18px;
  padding: 10px 20px;
  border-bottom: 1px solid var(--el-border-color);
  background: var(--el-bg-color);
}
.app-nav a {
  color: var(--el-text-color-secondary);
  text-decoration: none;
  font-size: 14px;
}
.app-nav a.router-link-active {
  color: var(--el-color-primary);
  font-weight: 600;
}
.app-content {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.nav-logout {
  margin-left: auto;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--el-text-color-secondary);
  font: inherit;
  font-size: 14px;
  cursor: pointer;
}
.nav-logout:hover {
  color: var(--el-color-primary);
}
.nav-logout:disabled {
  cursor: default;
  opacity: 0.6;
}
@media (max-width: 720px) {
  .app-nav { gap: 12px; padding: 9px 12px; overflow-x: auto; white-space: nowrap; }
  .nav-logout { flex: none; }
}
</style>

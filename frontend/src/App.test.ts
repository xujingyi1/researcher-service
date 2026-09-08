import { mount, flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import App from '@/App.vue'

const { auth, replace, autofigure } = vi.hoisted(() => ({
  auth: {
    role: '',
    isAuthenticated: false,
    logout: vi.fn(),
  },
  replace: vi.fn(),
  autofigure: {
    capability: 'unknown' as 'unknown' | 'enabled' | 'disabled',
    probe: vi.fn(),
  },
}))

vi.mock('@/stores/auth', () => ({
  useAuthStore: () => auth,
}))

vi.mock('@/stores/autofigure', () => ({
  useAutofigureStore: () => autofigure,
}))

vi.mock('vue-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-router')>()),
  useRouter: () => ({ replace }),
}))

describe('App navigation', () => {
  beforeEach(() => {
    auth.role = ''
    auth.isAuthenticated = false
    auth.logout.mockReset()
    replace.mockReset()
    autofigure.capability = 'unknown'
    autofigure.probe.mockReset()
  })

  it('主动退出后跳转登录页', async () => {
    auth.logout.mockResolvedValue(undefined)
    replace.mockResolvedValue(undefined)
    const wrapper = mount(App, {
      global: {
        mocks: { $route: { name: 'chat' } },
        stubs: { RouterLink: true, RouterView: true },
      },
    })

    await wrapper.get('[data-test="nav-logout"]').trigger('click')
    await flushPromises()

    expect(auth.logout).toHaveBeenCalledOnce()
    expect(replace).toHaveBeenCalledWith('/login')
    expect(auth.logout.mock.invocationCallOrder[0]).toBeLessThan(replace.mock.invocationCallOrder[0])
  })

  // T09：AutoFigure nav 入口跟随 capability——enabled 显示，disabled/unknown 隐藏
  // （直达 /figures 由 AutoFigureView 给「功能未启用」而非裸 404，nav 隐藏只是 UI）。
  it('AutoFigure nav 入口：capability enabled 时显示', () => {
    auth.isAuthenticated = true
    autofigure.capability = 'enabled'
    const wrapper = mount(App, {
      global: {
        mocks: { $route: { name: 'chat' } },
        stubs: { RouterLink: true, RouterView: true },
      },
    })
    expect(wrapper.find('[data-test="nav-figures"]').exists()).toBe(true)
  })

  it('AutoFigure nav 入口：capability disabled 时不显示', () => {
    auth.isAuthenticated = true
    autofigure.capability = 'disabled'
    const wrapper = mount(App, {
      global: {
        mocks: { $route: { name: 'chat' } },
        stubs: { RouterLink: true, RouterView: true },
      },
    })
    expect(wrapper.find('[data-test="nav-figures"]').exists()).toBe(false)
  })

  it('AutoFigure nav 入口：capability unknown（未探测/瞬态）时不显示', () => {
    auth.isAuthenticated = true
    autofigure.capability = 'unknown'
    const wrapper = mount(App, {
      global: {
        mocks: { $route: { name: 'chat' } },
        stubs: { RouterLink: true, RouterView: true },
      },
    })
    expect(wrapper.find('[data-test="nav-figures"]').exists()).toBe(false)
  })

  // F1（docs/figure-editor/reconnaissance.md）：Figure Editor 入口为常规受保护页——登录 shell 下
  // 恒显示，不随 AutoFigure capability / admin role 条件渲染（非 admin-only、非 flag-gated）。
  it('Figure Editor nav 入口：登录 shell 下显示', () => {
    auth.isAuthenticated = true
    const wrapper = mount(App, {
      global: {
        mocks: { $route: { name: 'chat' } },
        stubs: { RouterLink: true, RouterView: true },
      },
    })
    expect(wrapper.find('[data-test="nav-figure-editor"]').exists()).toBe(true)
  })

  // T09：认证态跟随探测——已登录时 App 挂载即触发一次 capability probe（nav 入口据此解析）。
  it('已登录时触发一次 capability probe', () => {
    auth.isAuthenticated = true
    mount(App, {
      global: {
        mocks: { $route: { name: 'chat' } },
        stubs: { RouterLink: true, RouterView: true },
      },
    })
    expect(autofigure.probe).toHaveBeenCalled()
  })

  it('未登录（public 路由）不触发 capability probe', () => {
    auth.isAuthenticated = false
    mount(App, {
      global: {
        mocks: { $route: { name: 'login' } },
        stubs: { RouterLink: true, RouterView: true },
      },
    })
    expect(autofigure.probe).not.toHaveBeenCalled()
  })
})

import type { ConfigEnv, UserConfig, UserConfigExport } from 'vite'
import { describe, expect, it, vi } from 'vitest'

vi.mock('vite', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vite')>()
  return {
    ...actual,
    loadEnv: () => ({
      VITE_BACKEND_HOST: 'backend.from-env.test:9999',
      VITE_FRONTEND_ERROR_REPORTING: 'true',
    }),
  }
})

import config from './vite.config'

async function resolveConfig(value: UserConfigExport): Promise<UserConfig> {
  if (typeof value !== 'function') return value
  const env: ConfigEnv = { command: 'build', mode: 'test', isSsrBuild: false, isPreview: false }
  return await value(env)
}

describe('Vite development proxy', () => {
  it('uses loaded environment values for the proxy and source maps', async () => {
    const resolved = await resolveConfig(config)
    expect(resolved.server?.proxy).toMatchObject({
      '/api/client-errors': 'http://backend.from-env.test:9999',
      '/api/site-logo': 'http://backend.from-env.test:9999',
    })
    expect(resolved.build?.sourcemap).toBe('hidden')
  })
})

describe('Vite+ test task', () => {
  it('allows cold frontend tests two minutes of idle startup time', async () => {
    const resolved = (await resolveConfig(config)) as UserConfig & {
      run: { tasks: { test: { command: string } } }
    }

    expect(resolved.run.tasks.test.command).toBe(
      'gadgets-with-timeout --idle 120 --max 600 -- vitest run',
    )
  })
})

// Mock UCP business fixture for compiled-binary integration tests.
// Lives in test/, never ships in dist/.
//
// This is a test fixture, not a reference server: routes are configured
// per-test, and only enough surface is implemented to satisfy the assertions
// the calling test makes.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

interface Route {
  method: string
  path: string
  handler: Handler
}

export interface MockBusiness {
  url: string
  port: number
  setRoute(method: string, path: string, handler: Handler): void
  reset(): void
  close(): Promise<void>
}

export interface MockBusinessOptions {
  port?: number
}

export async function startMockBusiness(options: MockBusinessOptions = {}): Promise<MockBusiness> {
  const routes: Route[] = []
  const server: Server = createServer(async (req, res) => {
    const url = req.url ?? ''
    const path = url.split('?')[0] ?? ''
    const method = req.method ?? 'GET'
    const route = routes.find((r) => r.method === method && r.path === path)
    if (route === undefined) {
      res.statusCode = 404
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({ error: { code: 'route_not_configured', message: `${method} ${path}` } }),
      )
      return
    }
    try {
      await route.handler(req, res)
    } catch (err) {
      res.statusCode = 500
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ error: { code: 'handler_threw', message: String(err) } }))
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const addr = server.address() as AddressInfo | null
  if (addr === null || typeof addr === 'string') {
    throw new Error('mock business: failed to bind a TCP port')
  }
  return {
    url: `http://127.0.0.1:${addr.port}`,
    port: addr.port,
    setRoute(method, path, handler) {
      routes.push({ method, path, handler })
    },
    reset() {
      routes.length = 0
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => (err === undefined ? resolve() : reject(err)))
      })
    },
  }
}

export function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}

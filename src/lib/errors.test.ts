// Error code registry verification.

import { Errors } from 'incur'
import { describe, expect, it } from 'vitest'
import { type ErrorCode, ErrorCodes, isUcpError, UcpError } from './errors.js'

describe('registered error codes', () => {
  it.each([
    ['PROTOCOL_VERSION_INCOMPATIBLE'],
    ['OPERATION_NOT_OFFERED'],
    ['NO_COMPATIBLE_TRANSPORT'],
    ['SCHEMA_VALIDATION_FAILED'],
    ['INVALID_INPUT'],
    ['BUSINESS_NOT_RESOLVED'],
  ])('%s is registered with a self-equal value', (code) => {
    expect((ErrorCodes as Record<string, string>)[code]).toBe(code)
  })

  it('keys equal values (codes are their own identifiers)', () => {
    for (const [k, v] of Object.entries(ErrorCodes)) {
      expect(v).toBe(k)
    }
  })

  it('ErrorCode type accepts arbitrary strings (forward-compat)', () => {
    // Compile-time intent: callers can pass service-specified codes
    // without a registry update.
    const userCode: ErrorCode = 'BUSINESS_SPECIFIC_CODE'
    expect(userCode).toBe('BUSINESS_SPECIFIC_CODE')
  })
})

describe('UcpError', () => {
  it('carries layer, code, and message', () => {
    const err = new UcpError({
      layer: 'transport',
      code: ErrorCodes.PROFILE_FETCH_FAILED,
      message: 'connection refused',
    })
    expect(err.layer).toBe('transport')
    expect(err.code).toBe('PROFILE_FETCH_FAILED')
    expect(err.message).toBe('connection refused')
  })

  it("extends incur Errors.IncurError so cli.serve()'s catch path catches it", () => {
    const err = new UcpError({ layer: 'client', code: 'X', message: 'y' })
    expect(err).toBeInstanceOf(Errors.IncurError)
    expect(err).toBeInstanceOf(UcpError)
  })

  it('passes through hint, retryable, and cause to the IncurError base', () => {
    const cause = new Error('underlying')
    const err = new UcpError({
      layer: 'transport',
      code: 'X',
      message: 'y',
      hint: 'try later',
      retryable: true,
      cause,
    })
    expect(err.hint).toBe('try later')
    expect(err.retryable).toBe(true)
    expect(err.exitCode).toBeUndefined()
    expect(err.cause).toBe(cause)
  })

  it('isUcpError narrows correctly', () => {
    expect(isUcpError(new UcpError({ layer: 'client', code: 'X', message: 'y' }))).toBe(true)
    expect(isUcpError(new Errors.IncurError({ code: 'X', message: 'y' }))).toBe(false)
    expect(isUcpError(new Error('x'))).toBe(false)
    expect(isUcpError('not an error')).toBe(false)
    expect(isUcpError(null)).toBe(false)
  })

  it('layer is enforced at the type level (compile-time), not just runtime', () => {
    // Type-level: the four legal values must all be assignable.
    new UcpError({ layer: 'application', code: 'X', message: 'y' })
    new UcpError({ layer: 'escalation', code: 'X', message: 'y' })
    new UcpError({ layer: 'transport', code: 'X', message: 'y' })
    new UcpError({ layer: 'client', code: 'X', message: 'y' })
    // (Wider strings would fail tsc at compile time — verified by typecheck.)
  })

  it('carries http_status and context when provided', () => {
    const err = new UcpError({
      layer: 'transport',
      code: ErrorCodes.TRANSPORT_HTTP_ERROR,
      message: 'endpoint returned 502',
      http_status: 502,
      context: { upstream: 'shop.example.com', body: '<html>bad gateway</html>' },
    })
    expect(err.http_status).toBe(502)
    expect(err.context).toStrictEqual({
      upstream: 'shop.example.com',
      body: '<html>bad gateway</html>',
    })
  })

  it('omits http_status and context when not provided', () => {
    const err = new UcpError({ layer: 'client', code: 'X', message: 'y' })
    expect(err.http_status).toBeUndefined()
    expect(err.context).toBeUndefined()
  })

  it('carries cta as a first-class field (not nested under context)', () => {
    // Recovery hint and diagnostic context have different audiences; agents
    // should grep `error.cta.commands`, not dig in `error.context.cta`.
    // Keeping these on separate fields makes that contract explicit.
    const err = new UcpError({
      layer: 'client',
      code: ErrorCodes.BUSINESS_NOT_RESOLVED,
      message: 'no business resolved',
      cta: {
        description: 'Set a session business or pass --business per call.',
        commands: [
          { command: 'ucp use <url>', description: 'bind a session business' },
          { command: 'ucp <op> --business <url> ...' },
        ],
      },
    })
    expect(err.cta).toStrictEqual({
      description: 'Set a session business or pass --business per call.',
      commands: [
        { command: 'ucp use <url>', description: 'bind a session business' },
        { command: 'ucp <op> --business <url> ...' },
      ],
    })
    expect(err.context).toBeUndefined()
  })

  it('omits cta when not provided', () => {
    const err = new UcpError({ layer: 'client', code: 'X', message: 'y' })
    expect(err.cta).toBeUndefined()
  })
})

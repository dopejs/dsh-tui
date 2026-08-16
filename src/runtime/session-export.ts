import { open, link, stat, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'

export interface SessionExportRequest {
  readonly destination: string
  readonly persistence: Pick<SessionPersistence, 'readRaw' | 'supportsRawArtifacts'>
  readonly sessionId: string
  readonly signal: AbortSignal
  readonly workspace: string
}

export interface SessionExportResult {
  readonly codeUnits: number
  readonly filename: string
  readonly path: string
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  const error = new Error('Session export was aborted', { cause: signal.reason })
  error.name = 'AbortError'
  return error
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal)
}

function combine(error: unknown, cleanup: unknown): AggregateError {
  return new AggregateError(
    [error, cleanup],
    'Session export failed and its temporary file could not be cleaned up',
  )
}

export async function exportRawSession(request: SessionExportRequest): Promise<SessionExportResult> {
  throwIfAborted(request.signal)
  if (!request.persistence.supportsRawArtifacts) {
    throw new Error('This session backend does not expose a raw artifact')
  }
  if (request.destination.trim() === '') throw new Error('Export destination must not be empty')
  const artifact = await request.persistence.readRaw(
    SessionId(request.sessionId),
    request.signal,
  )
  throwIfAborted(request.signal)
  if (artifact === undefined) throw new Error('The durable session artifact is not materialized')

  const destination = isAbsolute(request.destination)
    ? resolve(request.destination)
    : resolve(request.workspace, request.destination)
  const parent = dirname(destination)
  const parentStat = await stat(parent)
  if (!parentStat.isDirectory()) throw new Error('Export destination parent is not a directory')
  const temporary = resolve(parent, `.${basename(destination)}.dsh-tui-${randomUUID()}.tmp`)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  let primaryFailure: unknown
  let linked = false
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(artifact.content, { encoding: 'utf8' })
    await handle.sync()
    await handle.close()
    handle = undefined
    throwIfAborted(request.signal)
    await link(temporary, destination)
    linked = true
  } catch (error) {
    primaryFailure = error
  }

  let cleanupFailure: unknown
  try {
    await handle?.close()
    await unlink(temporary)
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? String(error.code)
      : undefined
    if (code !== 'ENOENT') cleanupFailure = error
  }
  if (primaryFailure !== undefined && cleanupFailure !== undefined) {
    throw combine(primaryFailure, cleanupFailure)
  }
  if (primaryFailure !== undefined) throw primaryFailure
  if (cleanupFailure !== undefined) {
    throw new Error(
      linked
        ? `Session was exported to ${destination}, but temporary-file cleanup failed`
        : 'Session export temporary-file cleanup failed',
      { cause: cleanupFailure },
    )
  }
  return Object.freeze({
    codeUnits: artifact.content.length,
    filename: artifact.filename,
    path: destination,
  })
}

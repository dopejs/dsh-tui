import { randomUUID } from 'node:crypto'
import { open, link, stat, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'

export interface SessionExportRequest {
  readonly destination: string
  readonly fileSystem?: SessionExportFileSystem
  readonly persistence: Pick<SessionPersistence, 'readRaw' | 'supportsRawArtifacts'>
  readonly sessionId: string
  readonly signal: AbortSignal
  readonly workspace: string
}

export interface SessionExportFileSystem {
  link(existingPath: string, newPath: string): Promise<void>
  open(
    path: string,
    flags: 'wx',
    mode: number,
  ): Promise<Pick<FileHandle, 'close' | 'sync' | 'writeFile'>>
  stat(path: string): Promise<{ isDirectory(): boolean }>
  unlink(path: string): Promise<void>
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

const DEFAULT_FILE_SYSTEM: SessionExportFileSystem = {
  link,
  open: (path, flags, mode) => open(path, flags, mode),
  stat,
  unlink,
}

function combine(error: unknown, cleanup: readonly unknown[]): AggregateError {
  return new AggregateError(
    [error, ...cleanup],
    'Session export failed and its temporary file could not be cleaned up',
  )
}

export async function exportRawSession(request: SessionExportRequest): Promise<SessionExportResult> {
  const fileSystem = request.fileSystem ?? DEFAULT_FILE_SYSTEM
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
  const parentStat = await fileSystem.stat(parent)
  if (!parentStat.isDirectory()) throw new Error('Export destination parent is not a directory')
  const temporary = resolve(parent, `.${basename(destination)}.dsh-tui-${randomUUID()}.tmp`)
  let handle: Pick<FileHandle, 'close' | 'sync' | 'writeFile'> | undefined
  let primaryFailure: unknown
  let linked = false
  let temporaryOwned = false
  try {
    handle = await fileSystem.open(temporary, 'wx', 0o600)
    temporaryOwned = true
    await handle.writeFile(artifact.content, { encoding: 'utf8' })
    await handle.sync()
    await handle.close()
    handle = undefined
    throwIfAborted(request.signal)
    await fileSystem.link(temporary, destination)
    linked = true
  } catch (error) {
    primaryFailure = error
  }

  const cleanupFailures: unknown[] = []
  if (handle !== undefined) {
    try {
      await handle.close()
    } catch (error) {
      cleanupFailures.push(error)
    }
  }
  if (temporaryOwned) {
    try {
      await fileSystem.unlink(temporary)
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : undefined
      if (code !== 'ENOENT') cleanupFailures.push(error)
    }
  }
  if (primaryFailure !== undefined && cleanupFailures.length > 0) {
    throw combine(primaryFailure, cleanupFailures)
  }
  if (primaryFailure !== undefined) throw primaryFailure
  if (cleanupFailures.length > 0) {
    const cause = cleanupFailures.length === 1
      ? cleanupFailures[0]
      : new AggregateError(cleanupFailures, 'Multiple export cleanup operations failed')
    throw new Error(
      linked
        ? `Session was exported to ${destination}, but temporary-file cleanup failed`
        : 'Session export temporary-file cleanup failed',
      { cause },
    )
  }
  return Object.freeze({
    codeUnits: artifact.content.length,
    filename: artifact.filename,
    path: destination,
  })
}

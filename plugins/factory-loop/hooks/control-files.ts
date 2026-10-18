// The owner's controls, the files (SPEC 4.3): control.json and the workspace config file, read and
// written whole over ActIo's readFile and writeFile. control.ts holds the ops and re-exports these.
import { EMPTY_CONTROL, controlFrom } from './config'
import { editSetting } from './config-keys'
import type { Setting } from './control'
import type { ActIo } from './exec'
import type { Control, Mode } from './types'

export function controlPath(loopDir: string): string {
  return `${loopDir}/control.json`
}

// The workspace config file (SPEC 4.1), where `mode` lives beside repo, shadowDevice and the rest.
export function configFilePath(configDir: string): string {
  return `${configDir}/factory-loop/config.json`
}

export type LoadedControl = { control: Control; error: string | null }

// loadControl: control.json's text as Control. A missing or empty file is no directive; a
// missing or malformed field takes its empty value (controlFrom). A file that is not a JSON
// object is an error, so a write never replaces directives the owner can still recover.
export function loadControl(text: string | null): LoadedControl {
  if (text === null || text.trim() === '') return { control: EMPTY_CONTROL, error: null }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { control: EMPTY_CONTROL, error: 'control.json is not valid JSON' }
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { control: EMPTY_CONTROL, error: 'control.json is not a JSON object' }
  return { control: controlFrom(raw), error: null }
}

export function controlText(control: Control): string {
  return JSON.stringify(control, null, 2) + '\n'
}

// The workspace config file's keys an op writes.
export type SettingKey = 'mode' | 'trace'

// withSetting: the workspace config file's text with one key set (`mode`, `trace`) and
// every other key kept, in place. A file that is not a JSON object is left alone: the owner's
// settings matter more than the op.
export function withSetting(text: string | null, key: SettingKey, value: Mode | boolean): { ok: true; text: string } | { ok: false; error: string } {
  let raw: unknown = {}
  if (text !== null && text.trim() !== '') {
    try {
      raw = JSON.parse(text)
    } catch {
      return { ok: false, error: 'the workspace config file is not valid JSON' }
    }
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'the workspace config file is not a JSON object' }
  return { ok: true, text: JSON.stringify({ ...(raw as Record<string, unknown>), [key]: value }, null, 2) + '\n' }
}

export function withMode(text: string | null, mode: Mode): { ok: true; text: string } | { ok: false; error: string } {
  return withSetting(text, 'mode', mode)
}

export type FileIo = Pick<ActIo, 'readFile' | 'writeFile'>

export async function readControl(io: FileIo, loopDir: string): Promise<LoadedControl> {
  return loadControl(await io.readFile(controlPath(loopDir)))
}

// writeControl: the whole file, every field (SPEC 4.3).
export async function writeControl(io: FileIo, loopDir: string, control: Control): Promise<void> {
  await io.writeFile(controlPath(loopDir), controlText(control))
}

// writeKey: `config set|unset` into the workspace file; changed says whether the file was written
export async function writeKey(io: FileIo, configDir: string, k: Setting, value: unknown): Promise<{ error: string | null; changed: boolean }> {
  const path = configFilePath(configDir)
  const next = editSetting(await io.readFile(path), k, value)
  if (!next.ok) return { error: next.error, changed: false }
  if (next.changed) await io.writeFile(path, next.text)
  return { error: null, changed: next.changed }
}

export async function writeSetting(io: FileIo, configDir: string, key: SettingKey, value: Mode | boolean): Promise<string | null> {
  const path = configFilePath(configDir)
  const next = withSetting(await io.readFile(path), key, value)
  if (!next.ok) return next.error
  await io.writeFile(path, next.text)
  return null
}

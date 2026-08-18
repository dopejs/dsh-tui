/**
 * Interface language.
 *
 * One table, one lookup, no runtime formatting library. Every key must exist in
 * every language: a partially translated interface is worse than an untranslated
 * one, because the missing half is the half the user was relying on.
 */

export type TuiLanguage = 'en' | 'zh'

export const LANGUAGES: readonly TuiLanguage[] = Object.freeze(['en', 'zh'])

export function isLanguage(value: string): value is TuiLanguage {
  return (LANGUAGES as readonly string[]).includes(value)
}

/** Message keys. Adding one here forces every language to answer for it. */
export interface Messages {
  readonly cancel: string
  readonly composerPlaceholder: string
  readonly gettingStarted: string
  readonly languageChanged: string
  readonly openedOverlay: string
  readonly overlayClosed: string
  readonly reasoningHidden: string
  readonly sendHint: string
  readonly tipActivity: string
  readonly tipExit: string
  readonly tipPalette: string
  readonly welcome: string
  readonly working: string
}

const EN: Messages = Object.freeze({
  cancel: '^C cancel',
  composerPlaceholder: 'Try "explain this repository" · ^P for the command palette',
  gettingStarted: 'Getting started',
  languageChanged: 'Interface language changed.',
  openedOverlay: 'Opened',
  overlayClosed: 'Overlay closed.',
  reasoningHidden: 'reasoning hidden · ^E show',
  sendHint: 'Enter send · ^J newline · ^S steer · ^C cancel',
  tipActivity: '^Y  activity · ^B jobs · ^G subagents',
  tipExit: '/exit  quit with a durable teardown',
  tipPalette: '^P  command palette — every action is here',
  welcome: 'Welcome. ^P opens the command palette — every action is listed there. Enter sends.',
  working: 'working',
})

const ZH: Messages = Object.freeze({
  cancel: '^C 取消',
  composerPlaceholder: '试试「解释一下这个仓库」· ^P 打开命令面板',
  gettingStarted: '快速上手',
  languageChanged: '界面语言已切换。',
  openedOverlay: '已打开',
  overlayClosed: '面板已关闭。',
  reasoningHidden: '推理已折叠 · ^E 展开',
  sendHint: 'Enter 发送 · ^J 换行 · ^S 插话 · ^C 取消',
  tipActivity: '^Y  活动 · ^B 任务 · ^G 子代理',
  tipExit: '/exit  安全退出并落盘',
  tipPalette: '^P  命令面板 — 所有操作都在这里',
  welcome: '欢迎。^P 打开命令面板，所有操作都在其中。Enter 发送。',
  working: '处理中',
})

const TABLES: Readonly<Record<TuiLanguage, Messages>> = Object.freeze({ en: EN, zh: ZH })

export function messages(language: TuiLanguage): Messages {
  return TABLES[language]
}

/**
 * The language to start in.
 *
 * An explicit preference wins. Otherwise the host's own locale decides, because
 * a user whose terminal is already Chinese did not choose English by default —
 * they simply never chose.
 */
export function resolveLanguage(
  preference: TuiLanguage | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): TuiLanguage {
  if (preference !== undefined) return preference
  const explicit = env.DSH_TUI_LANG
  if (explicit !== undefined && isLanguage(explicit)) return explicit
  const locale = env.LC_ALL ?? env.LC_MESSAGES ?? env.LANG ?? ''
  return locale.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

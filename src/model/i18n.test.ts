import { describe, expect, it } from 'vitest'

import { LANGUAGES, isLanguage, messages, resolveLanguage } from './i18n'

describe('i18n tables (M6.8)', () => {
  // A half-translated interface is worse than an untranslated one: the missing
  // half is the half the user was relying on.
  it('answers every key in every language', () => {
    const keys = Object.keys(messages('en')).sort()
    for (const language of LANGUAGES) {
      expect(Object.keys(messages(language)).sort()).toEqual(keys)
      for (const key of keys) {
        const value = messages(language)[key as keyof ReturnType<typeof messages>]
        expect(`${language}.${key}:${typeof value}`).toBe(`${language}.${key}:string`)
        expect(value.trim()).not.toBe('')
      }
    }
  })

  it('actually differs between languages', () => {
    expect(messages('zh').gettingStarted).not.toBe(messages('en').gettingStarted)
  })

  it('recognizes exactly the supported languages', () => {
    expect(isLanguage('en')).toBe(true)
    expect(isLanguage('zh')).toBe(true)
    expect(isLanguage('fr')).toBe(false)
    expect(isLanguage('')).toBe(false)
  })
})

describe('resolveLanguage (M6.8)', () => {
  it('lets an explicit preference win over everything', () => {
    expect(resolveLanguage('en', { LANG: 'zh_CN.UTF-8' })).toBe('en')
    expect(resolveLanguage('zh', { LANG: 'en_US.UTF-8' })).toBe('zh')
  })

  // A user whose terminal is already Chinese did not choose English; they
  // simply never chose.
  it('follows the host locale when nothing was chosen', () => {
    expect(resolveLanguage(undefined, { LANG: 'zh_CN.UTF-8' })).toBe('zh')
    expect(resolveLanguage(undefined, { LC_ALL: 'zh_TW' })).toBe('zh')
    expect(resolveLanguage(undefined, { LANG: 'en_US.UTF-8' })).toBe('en')
  })

  it('honours an explicit environment override above the locale', () => {
    expect(resolveLanguage(undefined, { DSH_TUI_LANG: 'zh', LANG: 'en_US.UTF-8' })).toBe('zh')
    expect(resolveLanguage(undefined, { DSH_TUI_LANG: 'nonsense', LANG: 'zh_CN' })).toBe('zh')
  })

  it('falls back to English when nothing says otherwise', () => {
    expect(resolveLanguage(undefined, {})).toBe('en')
  })
})

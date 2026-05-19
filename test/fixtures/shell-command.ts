import { platform } from 'node:process'

export function shellArg(value: string): string {
  if (platform === 'win32') return `"${value.replace(/"/g, '""')}"`
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function nodeHookCommand(script: string, ...args: string[]): string {
  return ['node', shellArg(script), ...args.map(shellArg)].join(' ')
}

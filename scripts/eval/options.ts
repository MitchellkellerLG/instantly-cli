export function replayOptions(args: string[]) {
  const values: Record<string, string> = { '--surface': 'legacy', '--split': 'all', '--output': '/tmp/instantly-offline' };
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!Object.hasOwn(values, flag)) throw new Error('UNSUPPORTED_REPLAY_OPTION: ' + flag);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error('MISSING_REPLAY_OPTION_VALUE: ' + flag);
    values[flag] = value;
  }
  if (!['legacy', 'safe', 'compact'].includes(values['--surface'])) throw new Error('UNSUPPORTED_SURFACE');
  if (!['all', 'train', 'validation', 'holdout'].includes(values['--split'])) throw new Error('INVALID_SPLIT');
  return { surface: values['--surface'] as 'legacy' | 'safe' | 'compact', split: values['--split'], directory: values['--output'] };
}

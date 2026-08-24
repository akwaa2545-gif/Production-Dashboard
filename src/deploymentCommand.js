export function commandInvocation(file, args, platform = process.platform) {
  if (platform === 'win32' && file === 'npm') {
    return { file: 'cmd.exe', args: ['/d', '/s', '/c', 'npm', ...args] };
  }
  return { file, args };
}

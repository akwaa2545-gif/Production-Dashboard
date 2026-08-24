export function npmCommandForPlatform(platform = process.platform) {
  return platform === 'win32' ? 'npm.cmd' : 'npm';
}

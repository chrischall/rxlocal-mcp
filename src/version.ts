// Single source of truth for the server's name and version. Release-please
// bumps the VERSION literal (listed in release-please-config.json
// `extra-files`), and tests/version-sync.test.ts guards it against
// package.json drift.
export const SERVER_NAME = 'rxlocal-mcp';
export const VERSION = '0.1.0'; // x-release-please-version

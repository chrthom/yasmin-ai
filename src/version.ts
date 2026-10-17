import packageJson from '../package.json';

/** The application version, read from package.json so the version string exists in exactly one place. */
export const version: string = packageJson.version;

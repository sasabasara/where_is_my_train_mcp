import pkg from "../package.json" with { type: "json" };

/** Single source for the server version (package.json). */
export const SERVER_VERSION: string = pkg.version;

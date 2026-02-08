// Minimal shims so `tsc` can typecheck source files that are only used in local tooling/tests
// or in code paths guarded away from Cloudflare Workers runtime.

declare namespace NodeJS {
  interface ErrnoException extends Error {
    code?: string;
  }
}

declare module 'node:child_process' {
  export const execFile: (...args: any[]) => any;
}

declare module 'node:util' {
  export const promisify: (fn: any) => any;
}

declare module 'node:fs/promises' {
  export const readFile: (...args: any[]) => any;
  export const access: (...args: any[]) => any;
}

declare module 'node:os' {
  export const homedir: () => string;
}


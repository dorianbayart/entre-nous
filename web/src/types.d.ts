declare module '@alpinejs/csp' {
  import Alpine from 'alpinejs';
  export default Alpine;
}

/** Version of this build (web/build.mjs). */
declare const __VERSION__: string;
/** CHANGELOG.md and CHANGELOG.en.md, newest first (web/build.mjs). */
declare const __CHANGELOG__: Array<{ version: string; date: string; fr: string[]; en: string[] }>;

// The one Vite API the runner uses (vitest resolves it at run time).
interface ImportMeta {
  glob<T>(pattern: string, options: { eager: true }): Record<string, T>;
}

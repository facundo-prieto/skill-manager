/** SKILL.md frontmatter, parsed as leniently as Claude Code does. */
export function frontmatter(text: string): Record<string, unknown> {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  try {
    return (Bun.YAML.parse(m[1]!) as Record<string, unknown>) ?? {};
  } catch {
    // Claude Code tolerates unquoted values containing ": " (invalid YAML); read flat `key: value` lines like it does
    return Object.fromEntries([...m[1]!.matchAll(/^([\w-]+):[ \t]*(.*)$/gm)].map(([, k, v]) => [k, v === "true" ? true : v]));
  }
}

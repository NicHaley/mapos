/**
 * Some model outputs omit the space after sentence-ending punctuation before the next
 * sentence ("one.Two"). Insert that space for display. Skips fenced and inline code so
 * dotted identifiers in snippets stay intact.
 */
export function normalizeAssistantMarkdownSpacing(text: string): string {
  const blocks: string[] = [];
  const masked = text.replace(/```[\s\S]*?```|`[^`\n]*`/g, (m) => {
    const id = blocks.length;
    blocks.push(m);
    return `\uFFF0${id}\uFFF1`;
  });

  const fixed = masked.replace(/([.!?])([A-Z])/g, "$1 $2");

  return fixed.replace(/\uFFF0(\d+)\uFFF1/g, (_, id: string) => blocks[Number(id)] ?? "");
}

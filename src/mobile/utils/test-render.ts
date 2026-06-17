/**
 * Test helpers for @testing-library/react-native screen specs.
 *
 * RNTL renders real React Native host components (no DOM), so there is no
 * `container.textContent`. `flattenScreenText` walks the rendered JSON tree and
 * concatenates every string leaf, giving the same "all visible text" string the
 * previous web-DOM specs relied on. This keeps `toContain` / `not.toContain`
 * assertions equivalent after the migration off react-test-renderer.
 */
import { screen } from '@testing-library/react-native';

type JsonNode =
  | string
  | number
  | null
  | undefined
  | { children?: JsonNode[] | JsonNode }
  | JsonNode[];

function collect(node: JsonNode, out: string[]): void {
  if (node == null || typeof node === 'boolean') return;
  if (typeof node === 'string') {
    out.push(node);
    return;
  }
  if (typeof node === 'number') {
    out.push(String(node));
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) collect(child, out);
    return;
  }
  collect((node as { children?: JsonNode }).children ?? null, out);
}

/** Concatenates all text rendered in the current screen tree. */
export function flattenScreenText(): string {
  const out: string[] = [];
  collect(screen.toJSON() as JsonNode, out);
  return out.join('');
}

/** Collects the `placeholder` prop of every rendered host node. */
export function collectPlaceholders(): string[] {
  const placeholders: string[] = [];
  const visit = (node: any): void => {
    if (node == null || typeof node === 'string') return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    const placeholder = node.props?.placeholder;
    if (typeof placeholder === 'string') placeholders.push(placeholder);
    const children = node.children;
    if (children) visit(children);
  };
  visit(screen.toJSON());
  return placeholders;
}

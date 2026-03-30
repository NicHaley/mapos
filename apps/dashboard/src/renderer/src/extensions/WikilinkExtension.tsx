import {
  Node,
  type JSONContent,
  type MarkdownParseHelpers,
  type MarkdownParseResult,
  type MarkdownRendererHelpers,
  type MarkdownToken,
  type RenderContext,
  mergeAttributes,
} from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, ReactRenderer } from "@tiptap/react";
import type { ReactNodeViewProps } from "@tiptap/react";
import { Suggestion, type SuggestionKeyDownProps, type SuggestionOptions, type SuggestionProps } from "@tiptap/suggestion";
import { PluginKey } from "@tiptap/pm/state";
import { cn } from "@renderer/lib/utils";
import {
  WikilinkSuggestion,
  type WikilinkItem,
  type WikilinkSuggestionRef,
} from "@renderer/components/WikilinkSuggestion";

export type { WikilinkItem };

const WikilinkPluginKey = new PluginKey("wikilink");

function WikilinkNodeView({ node, selected }: ReactNodeViewProps) {
  return (
    <NodeViewWrapper as="span" style={{ display: "inline" }}>
      <span
        className={cn(
          "inline-flex items-center rounded-full px-1.5 py-0.5 text-xs font-medium cursor-default",
          "bg-sidebar-accent text-sidebar-foreground ring-1 ring-sidebar-border",
          selected && "ring-2 ring-ring"
        )}
      >
        [[{node.attrs.title}]]
      </span>
    </NodeViewWrapper>
  );
}

function getSuggestionRenderCallbacks() {
  let renderer: ReactRenderer<WikilinkSuggestionRef> | null = null;

  return {
    onStart(props: SuggestionProps<WikilinkItem>) {
      renderer = new ReactRenderer<WikilinkSuggestionRef>(WikilinkSuggestion, {
        props,
        editor: props.editor,
      });
    },
    onUpdate(props: SuggestionProps<WikilinkItem>) {
      renderer?.updateProps(props);
    },
    onKeyDown({ event }: SuggestionKeyDownProps) {
      if (event.key === "Escape") {
        renderer?.destroy();
        renderer = null;
        return true;
      }
      return renderer?.ref?.onKeyDown({ event }) ?? false;
    },
    onExit() {
      renderer?.destroy();
      renderer = null;
    },
  };
}

export interface WikilinkOptions {
  suggestion: Omit<SuggestionOptions<WikilinkItem>, "editor">;
}

export const WikilinkExtension = Node.create<WikilinkOptions>({
  name: "wikilink",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      title: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-title"),
        renderHTML: (attrs) => ({ "data-title": attrs.title }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-wikilink]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes({ "data-wikilink": "" }, HTMLAttributes), 0];
  },

  addNodeView() {
    return ReactNodeViewRenderer(WikilinkNodeView);
  },

  markdownTokenName: "wikilink",

  markdownTokenizer: {
    name: "wikilink",
    level: "inline",
    start: "[[",
    tokenize(src: string, _tokens: MarkdownToken[]) {
      const match = src.match(/^\[\[([^\[\]]+?)\]\]/);
      if (!match) return undefined;
      return { type: "wikilink", raw: match[0], title: match[1].trim(), tokens: [] } as MarkdownToken & { title: string };
    },
  },

  parseMarkdown(token: MarkdownToken & { title?: string }, helpers: MarkdownParseHelpers): MarkdownParseResult {
    return helpers.createNode("wikilink", { title: token.title ?? "" });
  },

  renderMarkdown(node: JSONContent, _helpers: MarkdownRendererHelpers, _ctx: RenderContext): string {
    return `[[${node.attrs?.title ?? ""}]]`;
  },

  addOptions() {
    return {
      suggestion: {
        char: "[[",
        pluginKey: WikilinkPluginKey,
        allowSpaces: true,
        allowedPrefixes: null,
        items: (): WikilinkItem[] => [],
        command({ editor, range, props }: { editor: Parameters<typeof Suggestion>[0]["editor"]; range: { from: number; to: number }; props: WikilinkItem }) {
          editor
            .chain()
            .focus()
            .deleteRange(range)
            .insertContent({ type: "wikilink", attrs: { title: props.title } })
            .insertContent(" ")
            .run();
        },
        render: () => getSuggestionRenderCallbacks(),
      },
    };
  },

  addProseMirrorPlugins() {
    return [
      Suggestion<WikilinkItem>({
        editor: this.editor,
        ...this.options.suggestion,
      }),
    ];
  },
});

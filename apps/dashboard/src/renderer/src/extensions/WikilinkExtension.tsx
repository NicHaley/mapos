import {
  type WikilinkItem,
  WikilinkSuggestion,
  type WikilinkSuggestionProps,
  type WikilinkSuggestionRef
} from "@renderer/components/WikilinkSuggestion";
import { cn } from "@renderer/lib/utils";
import {
  type JSONContent,
  type MarkdownParseHelpers,
  type MarkdownParseResult,
  type MarkdownRendererHelpers,
  type MarkdownToken,
  Node,
  type RenderContext,
  mergeAttributes
} from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import { NodeViewWrapper, ReactNodeViewRenderer, ReactRenderer } from "@tiptap/react";
import type { ReactNodeViewProps } from "@tiptap/react";
import {
  Suggestion,
  type SuggestionKeyDownProps,
  type SuggestionOptions,
  type SuggestionProps
} from "@tiptap/suggestion";
import { SquareArrowOutUpRightIcon } from "lucide-react";

export type { WikilinkItem };

const WikilinkPluginKey = new PluginKey("wikilink");

function WikilinkNodeView({ node, selected, extension }: ReactNodeViewProps) {
  const onClickWikilink = (extension as { options: WikilinkOptions }).options.onClickWikilink;

  return (
    <NodeViewWrapper as="span" style={{ display: "inline" }}>
      <span
        role={onClickWikilink ? "button" : undefined}
        tabIndex={onClickWikilink ? 0 : undefined}
        onClick={
          onClickWikilink
            ? (e) => {
                e.stopPropagation();
                onClickWikilink(node.attrs.title, e.metaKey || e.ctrlKey);
              }
            : undefined
        }
        onKeyDown={
          onClickWikilink
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.stopPropagation();
                  onClickWikilink(node.attrs.title, e.metaKey || e.ctrlKey);
                }
              }
            : undefined
        }
        className={cn(
          "inline-flex items-center gap-0.5 underline underline-offset-2 decoration-sidebar-foreground/40",
          "text-sidebar-foreground",
          onClickWikilink ? "cursor-pointer hover:decoration-sidebar-foreground" : "cursor-default",
          selected && "bg-sidebar-accent rounded"
        )}
      >
        <SquareArrowOutUpRightIcon
          className="size-3 shrink-0 no-underline"
          style={{ textDecoration: "none" }}
        />
        {node.attrs.title}
      </span>
    </NodeViewWrapper>
  );
}

function getSuggestionRenderCallbacks() {
  let renderer: ReactRenderer<WikilinkSuggestionRef, WikilinkSuggestionProps> | null = null;

  return {
    onStart(props: SuggestionProps<WikilinkItem>) {
      renderer = new ReactRenderer<WikilinkSuggestionRef, WikilinkSuggestionProps>(
        WikilinkSuggestion,
        {
          props: {
            ...props,
            onDismiss: () => {
              renderer?.destroy();
              renderer = null;
            }
          },
          editor: props.editor
        }
      );
    },
    onUpdate(props: SuggestionProps<WikilinkItem>) {
      renderer?.updateProps(props);
    },
    onKeyDown({ event }: SuggestionKeyDownProps) {
      if (event.key === "Escape") {
        event.stopPropagation();
        renderer?.destroy();
        renderer = null;
        return true;
      }
      return renderer?.ref?.onKeyDown({ event }) ?? false;
    },
    onExit() {
      renderer?.destroy();
      renderer = null;
    }
  };
}

export interface WikilinkOptions {
  onClickWikilink?: (title: string, newTab: boolean) => void;
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
        renderHTML: (attrs) => ({ "data-title": attrs.title })
      }
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
      return {
        type: "wikilink",
        raw: match[0],
        title: match[1].trim(),
        tokens: []
      } as MarkdownToken & { title: string };
    }
  },

  parseMarkdown(
    token: MarkdownToken & { title?: string },
    helpers: MarkdownParseHelpers
  ): MarkdownParseResult {
    return helpers.createNode("wikilink", { title: token.title ?? "" });
  },

  renderMarkdown(
    node: JSONContent,
    _helpers: MarkdownRendererHelpers,
    _ctx: RenderContext
  ): string {
    return `[[${node.attrs?.title ?? ""}]]`;
  },

  addOptions() {
    return {
      onClickWikilink: undefined,
      suggestion: {
        char: "[[",
        pluginKey: WikilinkPluginKey,
        allowSpaces: true,
        allowedPrefixes: null,
        items: (): WikilinkItem[] => [],
        command({
          editor,
          range,
          props
        }: {
          editor: Parameters<typeof Suggestion>[0]["editor"];
          range: { from: number; to: number };
          props: WikilinkItem;
        }) {
          editor
            .chain()
            .focus()
            .deleteRange(range)
            .insertContent({ type: "wikilink", attrs: { title: props.title } })
            .insertContent(" ")
            .run();
        },
        render: () => getSuggestionRenderCallbacks()
      }
    };
  },

  addProseMirrorPlugins() {
    return [
      Suggestion<WikilinkItem>({
        editor: this.editor,
        ...this.options.suggestion
      })
    ];
  }
});

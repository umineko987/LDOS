import type { UiLanguage } from "../core/i18n";
import { language, translateUiText } from "../core/i18n";

interface LocalizedCopy {
  source: string;
  rendered: string;
}

const TRANSLATABLE_ATTRIBUTES = ["aria-label", "aria-description", "alt", "placeholder", "title"] as const;

export function localizeUi(node: HTMLElement): { destroy(): void } {
  const textCopies = new WeakMap<Text, LocalizedCopy>();
  const attributeCopies = new WeakMap<Element, Map<string, LocalizedCopy>>();
  let target: UiLanguage = "zh";

  const localizeTextNode = (textNode: Text): void => {
    const current = textNode.data;
    const previous = textCopies.get(textNode);
    const source = previous && current === previous.rendered ? previous.source : current;
    const rendered = translateUiText(source, target);
    textCopies.set(textNode, { source, rendered });
    if (current !== rendered) textNode.data = rendered;
  };

  const localizeAttribute = (element: Element, name: string): void => {
    const current = element.getAttribute(name);
    if (current === null) return;
    let copies = attributeCopies.get(element);
    if (!copies) {
      copies = new Map();
      attributeCopies.set(element, copies);
    }
    const previous = copies.get(name);
    const source = previous && current === previous.rendered ? previous.source : current;
    const rendered = translateUiText(source, target);
    copies.set(name, { source, rendered });
    if (current !== rendered) element.setAttribute(name, rendered);
  };

  const localizeTree = (root: Node): void => {
    if (root instanceof Text) localizeTextNode(root);
    if (root instanceof Element) {
      for (const name of TRANSLATABLE_ATTRIBUTES) localizeAttribute(root, name);
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const current = walker.currentNode;
      if (current instanceof Text) localizeTextNode(current);
      else if (current instanceof Element) {
        for (const name of TRANSLATABLE_ATTRIBUTES) localizeAttribute(current, name);
      }
    }
  };

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "characterData") localizeTextNode(mutation.target as Text);
      else if (mutation.type === "attributes") localizeAttribute(mutation.target as Element, mutation.attributeName!);
      else for (const added of mutation.addedNodes) localizeTree(added);
    }
  });

  observer.observe(node, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: [...TRANSLATABLE_ATTRIBUTES],
  });

  const unsubscribe = language.subscribe((next) => {
    target = next;
    document.documentElement.lang = next === "zh" ? "zh-CN" : "en";
    localizeTree(node);
  });

  return {
    destroy() {
      unsubscribe();
      observer.disconnect();
    },
  };
}

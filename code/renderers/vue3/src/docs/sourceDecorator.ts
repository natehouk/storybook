/* eslint-disable import/no-extraneous-dependencies */
/* eslint-disable no-underscore-dangle */
import { addons, useEffect } from '@storybook/preview-api';
import type { ArgTypes, Args, StoryContext, Renderer } from '@storybook/types';

import { getDocgenSection, SourceType, SNIPPET_RENDERED } from '@storybook/docs-tools';

import type {
  ElementNode,
  AttributeNode,
  DirectiveNode,
  TextNode,
  InterpolationNode,
  TemplateChildNode,
} from '@vue/compiler-core';
import { baseParse } from '@vue/compiler-core';
import type { Component, VNodeProps } from 'vue';
import { toDisplayString, h } from 'vue';
import { camelCase, kebabCase } from 'lodash';

type StoryVueComponent = Component & {
  render: any;
  props: VNodeProps;
  slots: any;
  tag?: string;
  name?: string;
  __name?: string;
  __file?: string;
  __docs?: any;
  __docsGen?: any;
  __docsExtracted?: any;
};
/**
 * Check if the sourcecode should be generated.
 *
 * @param context StoryContext
 */
const skipSourceRender = (context: StoryContext<Renderer>) => {
  const sourceParams = context?.parameters.docs?.source;
  const isArgsStory = context?.parameters.__isArgsStory;

  // always render if the user forces it
  if (sourceParams?.type === SourceType.DYNAMIC) {
    return false;
  }

  // never render if the user is forcing the block to render code, or
  // if the user provides code, or if it's not an args story.
  return !isArgsStory || sourceParams?.code || sourceParams?.type === SourceType.CODE;
};

const displayObject = (obj: Args) => {
  const a = Object.keys(obj).map((key) => `${key}:"${obj[key]}"`);
  return `{${a.join(',')}}`;
};
const htmlEventAttributeToVueEventAttribute = (key: string) => {
  return /^on[A-Za-z]/.test(key) ? key.replace(/^on/, 'v-on:').toLowerCase() : key;
};
// html event attribute to vue event attribute
// is html event attribute

const directiveSource = (key: string, value: unknown) =>
  key.includes('on')
    ? `${htmlEventAttributeToVueEventAttribute(key)}='()=>({})'`
    : `${key}='${value}'`;

const attributeSource = (key: string, value: unknown) =>
  // convert html event key to vue event key
  ['boolean', 'number', 'object'].includes(typeof value)
    ? `:${key}='${value && typeof value === 'object' ? displayObject(value) : value}'`
    : directiveSource(key, value);
/**
 *
 * @param _args
 * @param argTypes
 * @param byRef
 */
export function generateAttributesSource(
  tempArgs: (AttributeNode | DirectiveNode)[],
  args: Args,
  argTypes: ArgTypes,
  byRef?: boolean
): string {
  return Object.keys(tempArgs)
    .map((key: any) => {
      const arg = tempArgs[key];

      if (arg.type === 7) {
        const { arg: argName } = arg;
        const argKey = argName ? argName?.loc.source : undefined; // (argName as any)?.content;
        // const argExpValue = exp?.content;
        const propValue = args[camelCase(argKey)];

        const argValue = argKey ? propValue : toDisplayString(args);
        return argKey
          ? attributeSource(argKey, argValue)
          : toDisplayString(tempArgs[key].loc.source); // tempArgs[key].loc.source.replace(`"${argExpValue}"`, `'${argValue}'`);
      }
      return tempArgs[key].loc.source;
    })
    .join(' ');
}

/**
 *
 * @param args generate script setup from args
 * @param argTypes
 */
function generateScriptSetup(args: Args, argTypes: ArgTypes, components: any[]): string {
  const scriptLines = Object.keys(args).map(
    (key: any) =>
      `const ${key} = ${
        typeof args[key] === 'function' ? `()=>{}` : `ref(${JSON.stringify(args[key])});`
      }`
  );
  scriptLines.unshift(`import { ref } from "vue";`);

  return `<script lang='ts' setup>${scriptLines.join('\n')}</script>`;
}
/**
 * get component templates one or more
 * @param renderFn
 */
function getComponentsFromRenderFn(
  renderFn: any,
  context?: StoryContext<Renderer>
): TemplateChildNode[] {
  try {
    const { template } = context ? renderFn(context.args, context) : renderFn();
    if (!template) return [];
    return getComponentsFromTemplate(template);
  } catch (e) {
    return [];
  }
}

function getComponentsFromTemplate(template: string): TemplateChildNode[] {
  try {
    const ast = baseParse(template);
    const components = ast?.children;
    if (!components) return [];
    return components;
  } catch (e) {
    return [];
  }
}

/**
 * Generate a vue3 template.
 *
 * @param component Component
 * @param args Args
 * @param argTypes ArgTypes
 * @param slotProp Prop used to simulate a slot
 */

function generateSource(
  componentOrNodes: (StoryVueComponent | TemplateChildNode)[] | TemplateChildNode,
  args: Args,
  argTypes: ArgTypes,
  byRef = false
) {
  const isComponent = (component: any) => component && typeof component.render === 'function';
  const isElementNode = (node: any) => node && node.type === 1;
  const isInterpolationNode = (node: any) => node && node.type === 5;
  const isTextNode = (node: any) => node && node.type === 2;

  const generateComponentSource = (componentOrNode: StoryVueComponent | TemplateChildNode) => {
    if (isElementNode(componentOrNode)) {
      const { tag: name, props: attributes, children } = componentOrNode as ElementNode;
      const childSources: string = children
        .map((child: TemplateChildNode) => generateComponentSource(child))
        .join('');
      const props = generateAttributesSource(attributes, args, argTypes, byRef);
      return `<${name} ${props}>${childSources}</${name}>`;
    }

    if (isInterpolationNode(componentOrNode) || isTextNode(componentOrNode)) {
      const { content } = componentOrNode as InterpolationNode | TextNode;
      // eslint-disable-next-line no-eval
      if (typeof content !== 'string') return eval(content.loc.source); // it's a binding safe to eval
      return content;
    }

    if (isComponent(componentOrNode)) {
      const concreteComponent = componentOrNode as StoryVueComponent;
      const vnode = h(componentOrNode, args);
      const { props } = vnode;
      const { slots } = getDocgenSection(concreteComponent, 'slots') || {};
      const slotsProps = {} as Args;
      const attrsProps = { ...props };
      if (slots && props)
        Object.keys(props).forEach((prop: any) => {
          const isSlot = slots.find(({ name: slotName }: { name: string }) => slotName === prop);
          if (isSlot?.name) {
            slotsProps[prop] = props[prop];
            delete attrsProps[prop];
          }
        });
      const attributes = mapAttributesAndDirectives(attrsProps);
      const childSources: string = mapSlots(slotsProps)
        .map((child) => generateComponentSource(child))
        .join('');
      const name = concreteComponent.tag || concreteComponent.name || concreteComponent.__name;
      const propsSource = generateAttributesSource(attributes, args, argTypes, byRef);
      return `<${name} ${propsSource}>${childSources}</${name}>`;
    }

    return null;
  };

  const componentsOrNodes = Array.isArray(componentOrNodes) ? componentOrNodes : [componentOrNodes];
  const source = componentsOrNodes
    .map((componentOrNode) => generateComponentSource(componentOrNode))
    .join(' ');
  return source || null;
}

function mapAttributesAndDirectives(props: Args) {
  const tranformKey = (key: string) => (key.startsWith('on') ? key : kebabCase(key));
  return Object.keys(props).map(
    (key) =>
      ({
        name: 'bind',
        type: ['v-', '@', 'v-on'].includes(key) ? 7 : 6, // 6 is attribute, 7 is directive
        arg: { content: tranformKey(key), loc: { source: tranformKey(key) } }, // attribute name or directive name (v-bind, v-on, v-model)
        loc: { source: attributeSource(tranformKey(key), props[key]) }, // attribute value or directive value
        exp: { isStatic: false, loc: { source: props[key] } }, // directive expression
        modifiers: [''],
      } as unknown as AttributeNode)
  );
}
/**
 *  source decorator.
 * @param storyFn Fn
 * @param context  StoryContext
 */
export const sourceDecorator = (storyFn: any, context: StoryContext<Renderer>) => {
  const channel = addons.getChannel();
  const skip = skipSourceRender(context);
  const story = storyFn();

  let source: string;

  useEffect(() => {
    if (!skip && source) {
      const { id, args } = context;
      channel.emit(SNIPPET_RENDERED, { id, args, source, format: 'vue' });
    }
  });

  if (skip) {
    return story;
  }

  const { args = {}, component: ctxtComponent, argTypes = {} } = context || {};

  const components = getComponentsFromRenderFn(context?.originalStoryFn, context);

  const storyComponent = components.length ? components : (ctxtComponent as TemplateChildNode);

  const withScript = context?.parameters?.docs?.source?.withScriptSetup || false;
  const generatedScript = withScript ? generateScriptSetup(args, argTypes, components) : '';
  const generatedTemplate = generateSource(storyComponent, args, argTypes, withScript);

  if (generatedTemplate) {
    source = `${generatedScript}\n <template>\n ${generatedTemplate} \n</template>`;
  }

  return story;
};

function mapSlots(slotsProps: Args): TextNode[] {
  return Object.keys(slotsProps).map((key) => {
    const slot = slotsProps[key];
    let slotContent = '';
    if (typeof slot === 'function') slotContent = `<template #${key}>${slot()}</template>`;
    slotContent = `<template #${key}>${JSON.stringify(slot)}</template>`;
    if (key === 'default') {
      slotContent = JSON.stringify(slot);
    }

    return {
      type: 2,
      content: slotContent,
      loc: {
        source: slotContent,
        start: { offset: 0, line: 1, column: 0 },
        end: { offset: 0, line: 1, column: 0 },
      },
    };
  });
  // TODO: handle other cases (array, object, html,etc)
}

// export local function for testing purpose
export {
  generateScriptSetup,
  getComponentsFromRenderFn,
  getComponentsFromTemplate,
  mapAttributesAndDirectives,
  attributeSource,
  htmlEventAttributeToVueEventAttribute,
};

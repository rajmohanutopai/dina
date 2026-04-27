/**
 * Jest mock for `@expo/vector-icons` — the real package ships ESM that
 * Jest's CommonJS runtime can't consume without a transform, and adding
 * one for every icon family is more invasive than this stub. Tests that
 * render screens importing `Ionicons` only need the component to mount
 * without crashing; we don't visually assert glyphs in unit tests.
 */
import React from 'react';

function makeIconStub(family: string): React.ComponentType<Record<string, unknown>> {
  return function Icon(props) {
    return React.createElement('text', { ...props, 'data-icon-family': family });
  };
}

export const Ionicons = makeIconStub('Ionicons');
export const MaterialIcons = makeIconStub('MaterialIcons');
export const MaterialCommunityIcons = makeIconStub('MaterialCommunityIcons');
export const FontAwesome = makeIconStub('FontAwesome');
export const FontAwesome5 = makeIconStub('FontAwesome5');
export const Feather = makeIconStub('Feather');
export const AntDesign = makeIconStub('AntDesign');
export const Entypo = makeIconStub('Entypo');
export const Foundation = makeIconStub('Foundation');
export const EvilIcons = makeIconStub('EvilIcons');
export const Octicons = makeIconStub('Octicons');
export const SimpleLineIcons = makeIconStub('SimpleLineIcons');
export const Zocial = makeIconStub('Zocial');

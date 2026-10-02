/**
 * The offered item as its catalogue shows it: the supplier's photo when it
 * published an https one, a plain icon otherwise or when it fails to load,
 * and the bakery's PeerLens trust in words.
 */

import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import { OfferedItemCard, trustLine } from '../../src/components/OfferedItemCard';

const item = {
  name: 'Floral celebration cake',
  description: 'Vanilla sponge, buttercream flowers',
  quantityText: '1 each',
  imageUrl: 'https://images.example.test/floral-cake.jpg',
};

describe('OfferedItemCard', () => {
  it('shows the photo, name, description, quantity and trust', () => {
    const view = render(
      <OfferedItemCard item={item} trust={{ score: 0.82, reviewCount: 12 }} testID="o" />,
    );
    expect(view.getByTestId('o-photo').props.source).toEqual({ uri: item.imageUrl });
    expect(view.getByTestId('o-name').props.children).toBe('Floral celebration cake');
    expect(view.getByTestId('o-description').props.children).toBe(item.description);
    expect(view.getByTestId('o-quantity').props.children).toBe('1 each');
    expect(view.getByTestId('o-trust').props.children).toBe('Well trusted · 12 reviews');
  });

  it('never loads a photo that is not https', () => {
    const view = render(
      <OfferedItemCard
        item={{ ...item, imageUrl: 'http://images.example.test/a.jpg' }}
        trust={null}
        testID="o"
      />,
    );
    expect(view.queryByTestId('o-photo')).toBeNull();
    expect(view.getByTestId('o-no-photo')).toBeTruthy();
    expect(view.queryByTestId('o-trust')).toBeNull();
  });

  it('falls back to the icon when the photo fails to load', () => {
    const view = render(<OfferedItemCard item={item} trust={null} testID="o" />);
    fireEvent(view.getByTestId('o-photo'), 'error');
    expect(view.getByTestId('o-no-photo')).toBeTruthy();
  });
});

describe('trustLine', () => {
  it('reads PeerLens in words, and no reviews is not low trust', () => {
    expect(trustLine({ score: 0.5, reviewCount: 1 })).toBe('Some trust · 1 review');
    expect(trustLine({ score: 0.1, reviewCount: 5 })).toBe('Low trust · 5 reviews');
    expect(trustLine({ score: null, reviewCount: null })).toBe('No reviews yet');
  });
});

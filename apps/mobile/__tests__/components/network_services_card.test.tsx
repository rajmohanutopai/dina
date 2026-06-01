/**
 * NetworkServicesCard — the Services module on the Network tab.
 *
 * Pins the spec-5.5 contract: Services is a discoverable surface with a
 * Find affordance (→ Chat) and a provider-aware Publish/Manage
 * affordance (→ /service-settings). Presentational; handlers injected.
 */

import { render, fireEvent } from '@testing-library/react-native';
import React from 'react';

import { NetworkServicesCard } from '../../src/components/network_services_card';

describe('NetworkServicesCard', () => {
  it('always renders the Services heading + Find row', () => {
    const { getByTestId, getByText } = render(
      <NetworkServicesCard
        isProvider={false}
        onFindService={() => undefined}
        onPublishOrManage={() => undefined}
      />,
    );
    expect(getByTestId('network-services-card')).toBeTruthy();
    expect(getByText('Services')).toBeTruthy();
    expect(getByTestId('network-services-find')).toBeTruthy();
    expect(getByText('Find a service')).toBeTruthy();
  });

  it('requester-only node shows "Publish a service"', () => {
    const { getByText, queryByText } = render(
      <NetworkServicesCard
        isProvider={false}
        onFindService={() => undefined}
        onPublishOrManage={() => undefined}
      />,
    );
    expect(getByText('Publish a service')).toBeTruthy();
    expect(queryByText('My services')).toBeNull();
  });

  it('provider/both node shows "My services"', () => {
    const { getByText, queryByText } = render(
      <NetworkServicesCard
        isProvider
        onFindService={() => undefined}
        onPublishOrManage={() => undefined}
      />,
    );
    expect(getByText('My services')).toBeTruthy();
    expect(queryByText('Publish a service')).toBeNull();
  });

  it('tapping Find a service fires onFindService', () => {
    const onFind = jest.fn();
    const { getByTestId } = render(
      <NetworkServicesCard
        isProvider={false}
        onFindService={onFind}
        onPublishOrManage={() => undefined}
      />,
    );
    fireEvent.press(getByTestId('network-services-find'));
    expect(onFind).toHaveBeenCalledTimes(1);
  });

  it('tapping the publish row fires onPublishOrManage', () => {
    const onPublish = jest.fn();
    const { getByTestId } = render(
      <NetworkServicesCard
        isProvider={false}
        onFindService={() => undefined}
        onPublishOrManage={onPublish}
      />,
    );
    fireEvent.press(getByTestId('network-services-publish'));
    expect(onPublish).toHaveBeenCalledTimes(1);
  });
});
